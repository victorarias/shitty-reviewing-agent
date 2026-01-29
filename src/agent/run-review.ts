import { calculateCost, streamSimple, getModel } from "@mariozechner/pi-ai";
import type { Usage } from "@mariozechner/pi-ai";
import { buildSystemPrompt, buildUserPrompt } from "../prompt.js";
import { createGithubTools, createReadOnlyTools, createReviewTools, createSubagentTool, createWebSearchTool, RateLimitError } from "../tools/index.js";
import { filterToolsByAllowlist } from "../tools/categories.js";
import type { ChangedFile, ExistingComment, PullRequestInfo, ReviewConfig, ReviewContext, ReviewThreadInfo, ToolCategory } from "../types.js";
import { createAgentWithCompaction } from "./agent-setup.js";
import { countDistinctDirectories, filterDiagramFiles, filterIgnoredFiles } from "./file-filters.js";
import { maybeGenerateSequenceDiagram } from "./diagram.js";
import { isGemini3 } from "./model.js";
import { withRetries } from "./retries.js";
import { deriveErrorReason, postFailureSummary, postFallbackSummary } from "./summary.js";

export interface ReviewRunInput {
  config: ReviewConfig;
  context: ReviewContext;
  octokit: ReturnType<typeof import("@actions/github").getOctokit>;
  prInfo: PullRequestInfo;
  changedFiles: ChangedFile[];
  existingComments: ExistingComment[];
  reviewThreads: ReviewThreadInfo[];
  lastReviewedSha?: string | null;
  scopeWarning?: string | null;
  previousVerdict?: string | null;
  previousReviewUrl?: string | null;
  previousReviewAt?: string | null;
  previousReviewBody?: string | null;
  toolAllowlist?: ToolCategory[];
  overrides?: {
    agentFactory?: (params: {
      initialState: {
        systemPrompt: string;
        model: any;
        tools: any[];
        messages: any[];
        thinkingLevel: any;
      };
      transformContext: (messages: any[]) => Promise<any[]>;
      getApiKey: () => string;
      streamFn: typeof streamSimple;
    }) => AgentLike;
    streamFn?: typeof streamSimple;
    model?: ReturnType<typeof getModel>;
    compactionModel?: ReturnType<typeof getModel> | null;
  };
}

type AgentLike = {
  state: any;
  subscribe: (fn: (event: any) => void) => void;
  prompt: (input: any) => Promise<void>;
  abort: () => void;
};

export async function runReview(input: ReviewRunInput): Promise<void> {
  const { config, context, octokit } = input;
  const log = (...args: unknown[]) => {
    if (config.debug) {
      console.log("[debug]", ...args);
    }
  };

  // Gemini 3 is optimized for temperature=1.0; lower values cause looping/degraded behavior
  const effectiveTemperature = (() => {
    if (config.temperature !== undefined) {
      if (isGemini3(config.modelId) && config.temperature < 1.0) {
        console.warn(
          `[warn] Gemini 3 is optimized for temperature=1.0. You specified ${config.temperature}, which may cause unexpected behavior.`
        );
      }
      return config.temperature;
    }
    return isGemini3(config.modelId) ? 1.0 : undefined;
  })();
  const summaryState = {
    posted: false,
    inlineComments: 0,
    suggestions: 0,
    abortedByLimit: false,
    abortedByCancellation: false,
    billing: {
      input: 0,
      output: 0,
      total: 0,
      cost: 0,
    },
  };
  const contextState = {
    filesRead: new Set<string>(),
    filesDiffed: new Set<string>(),
    truncatedReads: new Set<string>(),
    partialReads: new Set<string>(),
  };

  const cache = {
    prInfo: input.prInfo,
    changedFiles: input.changedFiles,
  };

  const readTools = createReadOnlyTools(config.repoRoot);
  const githubTools = createGithubTools({
    octokit,
    owner: context.owner,
    repo: context.repo,
    pullNumber: context.prNumber,
    cache,
  });
  const reviewTools = createReviewTools({
    octokit,
    owner: context.owner,
    repo: context.repo,
    pullNumber: context.prNumber,
    headSha: input.prInfo.headSha,
    modelId: config.modelId,
    reviewSha: input.prInfo.headSha,
    changedFiles: input.changedFiles,
    getBilling: () => summaryState.billing,
    existingComments: input.existingComments,
    reviewThreads: input.reviewThreads,
    onSummaryPosted: () => {
      summaryState.posted = true;
    },
    summaryPosted: () => summaryState.posted,
    onInlineComment: () => {
      summaryState.inlineComments += 1;
    },
    onSuggestion: () => {
      summaryState.suggestions += 1;
    },
  });
  const webSearchTools = createWebSearchTool({
    apiKey: config.apiKey,
    modelId: config.modelId,
    enabled: config.provider === "google" || config.provider === "google-vertex",
    provider: config.provider,
  });

  const baseTools = [...readTools, ...githubTools, ...reviewTools, ...webSearchTools];
  const allowlistedBaseTools = filterToolsByAllowlist(baseTools, input.toolAllowlist);
  const subagentTool = createSubagentTool({
    config,
    buildTools: () => allowlistedBaseTools,
    overrides: input.overrides,
  });

  const tools = filterToolsByAllowlist([...allowlistedBaseTools, subagentTool], input.toolAllowlist);

  const { agent, model, effectiveThinkingLevel } = createAgentWithCompaction({
    config,
    systemPrompt: buildSystemPrompt(),
    tools,
    contextState,
    summaryState,
    temperatureOverride: effectiveTemperature,
    overrides: input.overrides,
  });

  const maxIterations = 10 + config.maxFiles * 5;
  let toolExecutions = 0;

  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      toolExecutions += 1;
      if (summaryState.posted) {
        console.warn(`[warn] tool called after summary: ${event.toolName}`);
      }
      if (event.toolName === "read" && event.args?.path) {
        contextState.filesRead.add(event.args.path);
        if (event.args.start_line || event.args.end_line) {
          contextState.partialReads.add(event.args.path);
        }
      }
      if ((event.toolName === "get_diff" || event.toolName === "get_full_diff") && event.args?.path) {
        contextState.filesDiffed.add(event.args.path);
      }
      log(`tool call: ${event.toolName}`, event.args ? safeStringify(event.args) : "{}");
      if (toolExecutions >= maxIterations) {
        summaryState.abortedByLimit = true;
        agent.abort();
      }
    }
    if (event.type === "tool_execution_end") {
      log(`tool end: ${event.toolName}`, event.isError ? "error" : "ok");
      if (event.toolName === "read" && event.result?.details?.truncated && event.result?.details?.path) {
        contextState.truncatedReads.add(event.result.details.path);
      }
      if (config.debug && event.result) {
        log(`tool output: ${event.toolName}`, safeStringify(event.result));
      }
      if (event.toolName === "terminate") {
        agent.abort();
      }
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const text = event.message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      const thinking = event.message.content
        .filter((c) => c.type === "thinking")
        .map((c) => c.thinking)
        .join("");
      if (text.trim()) {
        log(`assistant: ${text}`);
      }
      if (thinking.trim()) {
        log(`assistant thinking: ${thinking}`);
      }
      const usage = event.message.usage;
      if (usage) {
        const cost = calculateCost(model, usage);
        summaryState.billing.input += usage.input;
        summaryState.billing.output += usage.output;
        summaryState.billing.total += usage.totalTokens;
        summaryState.billing.cost += cost.total;
        log(
          `billing model=${event.message.model} input=${usage.input} output=${usage.output} total=${usage.totalTokens} cost=${cost.total.toFixed(6)}`
        );
      }
    }
    if (event.type === "agent_end") {
      log("agent end");
    }
  });

  const filteredFiles = filterIgnoredFiles(input.changedFiles, config.ignorePatterns);
  log(`filtered files: ${filteredFiles.length}`);
  const diagramFiles = await filterDiagramFiles(filteredFiles, config.repoRoot);
  const directoryCount = countDistinctDirectories(diagramFiles.map((file) => file.filename));
  const sequenceDiagram = await maybeGenerateSequenceDiagram({
    enabled: directoryCount > 3,
    model,
    tools: [...readTools, ...githubTools],
    config,
    prInfo: input.prInfo,
    changedFiles: filteredFiles,
    effectiveThinkingLevel,
    effectiveTemperature,
    log,
    onBilling: (usage: Usage) => {
      const cost = calculateCost(model, usage);
      summaryState.billing.input += usage.input;
      summaryState.billing.output += usage.output;
      summaryState.billing.total += usage.totalTokens;
      summaryState.billing.cost += cost.total;
    },
  });
  const userPrompt = buildUserPrompt({
    prTitle: input.prInfo.title,
    prBody: input.prInfo.body,
    changedFiles: filteredFiles.map((f) => f.filename),
    directoryCount,
    maxFiles: config.maxFiles,
    ignorePatterns: config.ignorePatterns,
    existingComments: input.existingComments.length,
    lastReviewedSha: input.lastReviewedSha,
    headSha: input.prInfo.headSha,
    scopeWarning: input.scopeWarning ?? null,
    previousVerdict: input.previousVerdict ?? null,
    previousReviewUrl: input.previousReviewUrl ?? null,
    previousReviewAt: input.previousReviewAt ?? null,
    previousReviewBody: input.previousReviewBody ?? null,
    sequenceDiagram,
  });

  let abortedByLimit = false;
  try {
    log("prompt start");
    await withRetries(
      async () => {
        await agent.prompt(userPrompt);
      },
      3,
      (error) => !summaryState.abortedByLimit && !isCancellationError(error)
    );
    log("prompt done");
  } catch (error) {
    if (isCancellationError(error)) {
      summaryState.abortedByCancellation = true;
      log("run canceled; skipping summary");
      return;
    }
    if (summaryState.abortedByLimit) {
      abortedByLimit = true;
    } else {
      const reason =
        error instanceof RateLimitError
          ? "GitHub API rate limit exceeded."
          : "LLM request failed after retries.";
      await postFailureSummary({
        octokit,
        owner: context.owner,
        repo: context.repo,
        prNumber: context.prNumber,
        reason,
        model: config.modelId,
        billing: summaryState.billing,
        reviewSha: input.prInfo.headSha,
      });
      throw error;
    }
  }

  if (agent.state.error) {
    log(`agent error: ${agent.state.error}`);
  }

  if (isCancellationError(agent.state.error)) {
    summaryState.abortedByCancellation = true;
    log("run canceled; skipping summary");
    return;
  }

  if (!summaryState.posted && agent.state.error) {
    const reason = deriveErrorReason(agent.state.error);
    await postFailureSummary({
      octokit,
      owner: context.owner,
      repo: context.repo,
      prNumber: context.prNumber,
      reason,
      model: config.modelId,
      billing: summaryState.billing,
      reviewSha: input.prInfo.headSha,
    });
    return;
  }

  if (summaryState.abortedByCancellation) {
    return;
  }

  if (!summaryState.posted) {
    const verdict = "Skipped";
    const reason = summaryState.abortedByLimit || abortedByLimit
      ? "Agent exceeded iteration limit before posting summary."
      : "Agent failed to produce a review summary.";
    await postFallbackSummary({
      octokit,
      owner: context.owner,
      repo: context.repo,
      prNumber: context.prNumber,
      model: config.modelId,
      verdict,
      reason,
      billing: summaryState.billing,
      reviewSha: input.prInfo.headSha,
    });
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return `[unserializable]: ${String(error)}`;
  }
}

function isCancellationError(error: unknown): boolean {
  if (!error) return false;
  const message = typeof error === "string"
    ? error
    : String((error as { message?: unknown })?.message ?? error);
  return /operation was canceled|cancell?ed|abort(ed)?/i.test(message);
}
