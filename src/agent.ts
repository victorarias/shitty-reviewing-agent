import { Agent } from "@mariozechner/pi-agent-core";
import { calculateCost, getModel, streamSimple } from "@mariozechner/pi-ai";
import type { Usage } from "@mariozechner/pi-ai";
import { minimatch } from "minimatch";
import type { getOctokit } from "@actions/github";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentTool } from "@mariozechner/pi-agent-core";
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
    onBilling: (usage) => {
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

const execFileAsync = promisify(execFile);
const generatedCache = new Map<string, boolean>();

export async function filterDiagramFiles(files: ChangedFile[], repoRoot: string): Promise<ChangedFile[]> {
  const results = await Promise.all(
    files.map(async (file) => {
      if (isTestPath(file.filename)) return null;
      const isGenerated = await isGeneratedPath(repoRoot, file.filename);
      if (isGenerated) return null;
      return file;
    })
  );
  return results.filter(Boolean) as ChangedFile[];
}

export function isTestPath(file: string): boolean {
  const patterns = [
    "**/__tests__/**",
    "**/test/**",
    "**/tests/**",
    "**/*.test.*",
    "**/*.spec.*",
    "**/*_test.*",
    "**/*-test.*",
  ];
  return patterns.some((pattern) => minimatch(file, pattern));
}

export async function isGeneratedPath(repoRoot: string, file: string): Promise<boolean> {
  const cached = generatedCache.get(file);
  if (cached !== undefined) return cached;
  try {
    const { stdout } = await execFileAsync("git", ["check-attr", "linguist-generated", "--", file], {
      cwd: repoRoot,
    });
    const value = stdout.trim().split(":").pop()?.trim();
    const isGenerated = value === "true" || value === "set";
    generatedCache.set(file, isGenerated);
    return isGenerated;
  } catch {
    generatedCache.set(file, false);
    return false;
  }
}

function countDistinctDirectories(files: string[]): number {
  const dirs = new Set<string>();
  for (const file of files) {
    const dir = path.posix.dirname(file);
    dirs.add(dir === "." ? "(root)" : dir);
  }
  return dirs.size;
}

async function maybeGenerateSequenceDiagram(params: {
  enabled: boolean;
  model: ReturnType<typeof getModel>;
  tools: AgentTool<any>[];
  config: ReviewConfig;
  prInfo: PullRequestInfo;
  changedFiles: ChangedFile[];
  effectiveThinkingLevel: ThinkingLevel;
  effectiveTemperature?: number;
  log: (...args: unknown[]) => void;
  onBilling?: (usage: Usage) => void;
}): Promise<string | null> {
  if (!params.enabled) return null;

  const diagramAgent = new Agent({
    initialState: {
      systemPrompt: buildDiagramSystemPrompt(),
      model: params.model,
      tools: params.tools,
      messages: [],
      thinkingLevel: params.effectiveThinkingLevel,
    },
    getApiKey: () => params.config.apiKey,
    streamFn: (modelArg, context, options) =>
      streamSimple(modelArg, context, {
        ...options,
        temperature: params.effectiveTemperature ?? options.temperature,
      }),
  });
  diagramAgent.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant" && event.message.usage) {
      params.onBilling?.(event.message.usage);
    }
  });

  const diagramPrompt = buildDiagramUserPrompt({
    prTitle: params.prInfo.title,
    prBody: params.prInfo.body,
    changedFiles: params.changedFiles.map((file) => file.filename),
  });

  try {
    await diagramAgent.prompt(diagramPrompt);
    const text = extractAssistantText(diagramAgent.state.messages);
    const diagram = normalizeMermaidDiagram(text);
    if (!diagram) {
      params.log("diagram agent produced no usable output");
      return null;
    }
    return diagram;
  } catch (error) {
    params.log("diagram agent failed", error);
    return null;
  }
}

function buildDiagramSystemPrompt(): string {
  return `# Role
You generate a Mermaid sequence diagram for a pull request.

# Constraints
- Output Mermaid sequence diagram code only. Do not wrap in markdown fences or add commentary.
- Start with "sequenceDiagram".
- Keep it concise and focused on key interactions introduced or modified by the PR.

# Workflow
1) Read the PR context and changed files.
2) Use get_diff and read to understand key interactions.
3) Produce the sequence diagram code.`;
}

function buildDiagramUserPrompt(params: { prTitle: string; prBody: string; changedFiles: string[] }): string {
  const body = params.prBody?.trim() ? params.prBody.trim() : "(no description)";
  const files = params.changedFiles.length > 0 ? params.changedFiles.map((f) => `- ${f}`).join("\n") : "(none)";
  return `# PR Context
PR title: ${params.prTitle}
PR description: ${body}

Changed files:
${files}

# Task
Generate a mermaid sequence diagram (only the code, no fences). Use tools if needed.`;
}

function extractAssistantText(messages: any[]): string {
  const lastAssistant = [...messages].reverse().find((msg) => msg?.role === "assistant");
  if (!lastAssistant) return "";
  const content = lastAssistant.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === "text" && typeof part?.text === "string")
      .map((part) => part.text)
      .join("");
  }
  return "";
}

function normalizeMermaidDiagram(text: string): string | null {
  if (!text) return null;
  let normalized = text.trim();
  const fenced = normalized.match(/```mermaid\s*([\s\S]*?)```/i);
  if (fenced) {
    normalized = fenced[1].trim();
  }
  const sequenceIndex = normalized.indexOf("sequenceDiagram");
  if (sequenceIndex > 0) {
    normalized = normalized.slice(sequenceIndex);
  }
  if (!normalized.startsWith("sequenceDiagram")) {
    return null;
  }
  return normalized;
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
