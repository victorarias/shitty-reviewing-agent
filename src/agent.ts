import { Agent } from "@mariozechner/pi-agent-core";
import { calculateCost, getModel, streamSimple } from "@mariozechner/pi-ai";
import { minimatch } from "minimatch";
import type { getOctokit } from "@actions/github";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";
import { buildSummaryMarkdown } from "./summary.js";
import { createGithubTools, createReadOnlyTools, createReviewTools, createWebSearchTool, RateLimitError } from "./tools/index.js";
import type { ChangedFile, ExistingComment, PullRequestInfo, ReviewConfig, ReviewContext, ReviewThreadInfo } from "./types.js";

type Octokit = ReturnType<typeof getOctokit>;

export interface ReviewRunInput {
  config: ReviewConfig;
  context: ReviewContext;
  octokit: Octokit;
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
}

function isGemini3(modelId: string): boolean {
  return /gemini[- ]?3/i.test(modelId);
}

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Map granular thinking levels to Gemini 3's supported levels (low/high).
 * Gemini 3 only supports "low" and "high" thinking levels.
 */
function mapThinkingLevelForGemini3(level: ThinkingLevel): ThinkingLevel {
  switch (level) {
    case "off":
    case "minimal":
    case "low":
      return "low";
    case "medium":
    case "high":
    case "xhigh":
      return "high";
  }
}

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

  // Map thinking levels for Gemini 3 (only supports low/high)
  const effectiveThinkingLevel = isGemini3(config.modelId)
    ? mapThinkingLevelForGemini3(config.reasoning)
    : config.reasoning;
  const summaryState = {
    posted: false,
    inlineComments: 0,
    suggestions: 0,
    abortedByLimit: false,
    billing: {
      input: 0,
      output: 0,
      total: 0,
      cost: 0,
    },
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
    enabled: config.provider === "google",
  });

  const tools = [...readTools, ...githubTools, ...reviewTools, ...webSearchTools];

  const model = getModel(config.provider as any, config.modelId as any);
  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(),
      model,
      tools,
      messages: [],
      thinkingLevel: effectiveThinkingLevel,
    },
    getApiKey: () => config.apiKey,
    streamFn: (modelArg, context, options) =>
      streamSimple(modelArg, context, {
        ...options,
        temperature: effectiveTemperature ?? options.temperature,
      }),
  });

  const maxIterations = 10 + config.maxFiles * 5;
  let toolExecutions = 0;

  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      toolExecutions += 1;
      if (summaryState.posted) {
        console.warn(`[warn] tool called after summary: ${event.toolName}`);
        agent.abort();
        return;
      }
      log(`tool start: ${event.toolName}`, event.args ?? "");
      if (toolExecutions >= maxIterations) {
        summaryState.abortedByLimit = true;
        agent.abort();
      }
    }
    if (event.type === "tool_execution_end") {
      log(`tool end: ${event.toolName}`, event.isError ? "error" : "ok");
      if (config.debug && event.result) {
        log(`tool output: ${event.toolName}`, safeStringify(event.result));
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
  const userPrompt = buildUserPrompt({
    prTitle: input.prInfo.title,
    prBody: input.prInfo.body,
    changedFiles: filteredFiles.map((f) => f.filename),
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
  });

  let abortedByLimit = false;
  try {
    log("prompt start");
    await withRetries(
      async () => {
        await agent.prompt(userPrompt);
      },
      3,
      () => !summaryState.abortedByLimit
    );
    log("prompt done");
  } catch (error) {
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

function deriveErrorReason(message: string): string {
  if (isQuotaError(message)) {
    return "LLM quota exceeded or rate-limited; unable to generate a review. Check provider billing/limits.";
  }
  return "Agent encountered an error and failed to produce a review summary.";
}

function isQuotaError(message: string): boolean {
  return /quota|resource_exhausted|rate limit|429/i.test(message);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return `[unserializable]: ${String(error)}`;
  }
}

function filterIgnoredFiles(files: ChangedFile[], ignorePatterns: string[]): ChangedFile[] {
  if (ignorePatterns.length === 0) return files;
  return files.filter((file) => !ignorePatterns.some((pattern) => minimatch(file.filename, pattern)));
}

async function withRetries(
  fn: () => Promise<void>,
  attempts: number,
  shouldRetry: (error: unknown) => boolean
): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fn();
      return;
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error)) {
        throw error;
      }
      const waitMs = 1000 * Math.pow(2, i);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastError;
}

async function postFailureSummary(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  reason: string;
  model: string;
  billing: {
    input: number;
    output: number;
    total: number;
    cost: number;
  };
  reviewSha: string;
}): Promise<void> {
  await params.octokit.rest.issues.createComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.prNumber,
    body: buildSummaryMarkdown({
      verdict: "Skipped",
      issues: [params.reason],
      keyFindings: ["None"],
      multiFileSuggestions: ["None"],
      model: params.model,
      billing: params.billing,
      reviewSha: params.reviewSha,
    }),
  });
}

async function postFallbackSummary(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  model: string;
  verdict: string;
  reason: string;
  billing: {
    input: number;
    output: number;
    total: number;
    cost: number;
  };
  reviewSha: string;
}): Promise<void> {
  await params.octokit.rest.issues.createComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.prNumber,
    body: buildSummaryMarkdown({
      verdict: params.verdict,
      issues: [params.reason],
      keyFindings: ["None"],
      multiFileSuggestions: ["None"],
      model: params.model,
      billing: params.billing,
      reviewSha: params.reviewSha,
    }),
  });
}
