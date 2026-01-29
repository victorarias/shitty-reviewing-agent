import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { runReview } from "../../src/agent.ts";
import { runScheduledFlow } from "../../src/app/schedule.ts";
import { runCommand } from "../../src/commands/run.ts";
import type {
  ActionConfig,
  ChangedFile,
  ExistingComment,
  IncludeExclude,
  PullRequestInfo,
  ReviewConfig,
  ReviewContext,
  ReviewThreadInfo,
} from "../../src/types.ts";
import { makeOctokitSpy } from "./fake-octokit.ts";

type ScenarioConfig = {
  provider?: string;
  modelId: string;
  temperature?: number;
  reasoning?: ReviewConfig["reasoning"];
  maxFiles?: number;
  ignorePatterns?: string[];
  contextWindow?: number;
  preloadChars?: number;
};

type ScenarioExpected = {
  summaryContains?: string[];
  minInlineComments?: number;
  maxInlineComments?: number;
  minSuggestions?: number;
  compactionTriggered?: boolean;
  prCreated?: boolean;
  prUpdated?: boolean;
  changedFilesInclude?: string[];
  llmChanges?: boolean;
  toolCallsInclude?: string[];
};

type Scenario = {
  id: string;
  description?: string;
  mode?: "review" | "schedule";
  config: ScenarioConfig;
  changedFiles: ChangedFile[];
  existingComments?: ExistingComment[];
  reviewThreads?: ReviewThreadInfo[];
  schedule?: {
    commandPrompt: string;
    commandId?: string;
    writeScope?: IncludeExclude;
    seedFiles?: Record<string, string>;
    pr?: {
      base?: string;
      title?: string;
      body?: string;
    };
  };
  expected?: ScenarioExpected;
};

type NormalizedCall =
  | { type: "issue_comment"; body: string }
  | { type: "review_comment"; path: string; line: number; side: "LEFT" | "RIGHT"; body: string }
  | { type: "reply"; comment_id: number; body: string }
  | { type: string };

type Snapshot = {
  id: string;
  description?: string;
  mode: "review" | "schedule";
  config: {
    provider: string;
    modelId: string;
    temperature?: number;
    reasoning?: ReviewConfig["reasoning"];
    maxFiles: number;
    ignorePatterns: string[];
    contextWindow?: number;
    preloadChars?: number;
  };
  compactionTriggered: boolean;
  issueComments: string[];
  reviewComments: Array<{ path: string; line: number; side: "LEFT" | "RIGHT"; body: string }>;
  replies: Array<{ comment_id: number; body: string }>;
  schedule?: {
    prCreated: boolean;
    prUpdated: boolean;
    changedFiles: string[];
    gitCalls: string[];
    toolCalls: string[];
    llmChanges: boolean;
    assistantMessages: string[];
    commandRan: boolean;
  };
  stats: {
    issueComments: number;
    reviewComments: number;
    replies: number;
    suggestions: number;
  };
  calls: NormalizedCall[];
};

const baseContext: ReviewContext = {
  owner: "owner",
  repo: "repo",
  prNumber: 1,
};

const basePrInfo: PullRequestInfo = {
  number: 1,
  title: "Snapshot Test PR",
  body: "Automated snapshot test.",
  author: "tester",
  baseRef: "main",
  headRef: "snapshot",
  baseSha: "base",
  headSha: "head",
  url: "https://example.com/pr/1",
};

export function loadScenarios(): Scenario[] {
  const scenarioDir = path.join(process.cwd(), "tests", "fixtures", "llm", "scenarios");
  const files = fs
    .readdirSync(scenarioDir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  return files.map((file) => {
    const raw = fs.readFileSync(path.join(scenarioDir, file), "utf8");
    return JSON.parse(raw) as Scenario;
  });
}

export interface RunScenarioOptions {
  timeoutMs?: number;
  debug?: boolean;
}

function formatTimeoutInfo(pairs: Array<[string, string | number | boolean | undefined]>): string {
  const formatted = pairs
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return formatted;
}

export async function runScenario(
  scenario: Scenario,
  apiKey: string,
  options: RunScenarioOptions = {}
): Promise<{ snapshot: Snapshot }> {
  if (scenario.mode === "schedule") {
    return runScheduleScenario(scenario, apiKey, options);
  }
  const { octokit, calls } = makeOctokitSpy();
  let compactionTriggered = false;
  const debug = options.debug ?? false;
  const timeoutMs = options.timeoutMs ?? 120000;
  let lastEvent = "no agent events yet";
  const toolCalls: string[] = [];
  const assistantMessages: string[] = [];
  let lastAgent: any = null;
  const debugLog = (message: string) => {
    if (debug) {
      console.log(`[llm-snapshot:${scenario.id}] ${message}`);
    }
  };

  const provider = scenario.config.provider ?? "google-vertex";
  const maxFiles = scenario.config.maxFiles ?? 5;
  const ignorePatterns = scenario.config.ignorePatterns ?? ["*.lock", "*.generated.*"];

  const config: ReviewConfig = {
    provider,
    apiKey,
    modelId: scenario.config.modelId,
    maxFiles,
    ignorePatterns,
    repoRoot: process.cwd(),
    debug: false,
    reasoning: scenario.config.reasoning ?? "low",
    temperature: scenario.config.temperature,
  };

  let overrideModel: ReturnType<typeof getModel> | undefined;
  if (scenario.config.contextWindow) {
    overrideModel = getModel(provider as any, scenario.config.modelId as any);
    overrideModel.contextWindow = scenario.config.contextWindow;
  }

  const agentFactory = ({ initialState, transformContext, getApiKey, streamFn }: any) => {
    const preloadChars = scenario.config.preloadChars ?? 0;
    if (preloadChars > 0) {
      const filler = "x".repeat(preloadChars);
      initialState.messages = [
        ...initialState.messages,
        { role: "user", content: `Preloaded context:\n${filler}` },
      ];
    }
    const wrappedTransform = async (messages: any[]) => {
      const result = await transformContext(messages);
      const sawCompaction = result.some((msg: any) =>
        typeof msg?.content === "string" && msg.content.includes("Compacted context summary:")
      );
      if (sawCompaction) {
        compactionTriggered = true;
      }
      return result;
    };
    const agent = new Agent({
      initialState,
      transformContext: wrappedTransform,
      getApiKey,
      streamFn,
    });
    lastAgent = agent;
    agent.subscribe((event: any) => {
      if (event.type === "tool_execution_start") {
        toolCalls.push(event.toolName);
        lastEvent = `tool:${event.toolName}`;
        debugLog(`tool ${event.toolName}`);
      }
      if (event.type === "tool_execution_end") {
        lastEvent = `tool_end:${event.toolName}`;
        debugLog(`tool end ${event.toolName}`);
      }
      if (event.type === "tool_execution_error") {
        lastEvent = `tool_error:${event.toolName}`;
        debugLog(`tool error ${event.toolName}`);
      }
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const text = (event.message.content ?? [])
          .filter((part: any) => part.type === "text")
          .map((part: any) => part.text)
          .join("")
          .trim();
        if (text) {
          assistantMessages.push(text);
          lastEvent = `assistant:${text.slice(0, 120)}`;
          debugLog(`assistant ${text.slice(0, 120)}`);
        }
      }
    });
    return agent;
  };

  await withTimeout(
    `runReview:${scenario.id}`,
    runReview({
      config,
      context: baseContext,
      octokit: octokit as any,
      prInfo: basePrInfo,
      changedFiles: scenario.changedFiles,
      existingComments: scenario.existingComments ?? [],
      reviewThreads: scenario.reviewThreads ?? [],
      overrides: {
        agentFactory,
        model: overrideModel,
      },
    }),
    timeoutMs,
    () => {
      const toolTail = toolCalls.slice(-5).join(",");
      const assistantTail = assistantMessages.slice(-2).map((msg) => msg.slice(0, 120)).join(" | ");
      const messageCount = Array.isArray(lastAgent?.state?.messages) ? lastAgent.state.messages.length : 0;
      return formatTimeoutInfo([
        ["lastEvent", lastEvent],
        ["toolTail", toolTail],
        ["assistantTail", assistantTail],
        ["messages", messageCount || undefined],
        ["octokitCalls", calls.length],
      ]);
    }
  );

  const snapshot = buildSnapshot(scenario, calls, compactionTriggered);
  return { snapshot };
}

export function assertScenarioExpectations(scenario: Scenario, snapshot: Snapshot) {
  const expected = scenario.expected;
  if (!expected) return;
  if (expected.summaryContains) {
    const summary = snapshot.issueComments[0] ?? "";
    for (const fragment of expected.summaryContains) {
      if (!summary.includes(fragment)) {
        throw new Error(`Expected summary to contain "${fragment}" for scenario ${scenario.id}.`);
      }
    }
  }
  if (expected.minInlineComments !== undefined && snapshot.stats.reviewComments < expected.minInlineComments) {
    throw new Error(`Expected at least ${expected.minInlineComments} inline comment(s) for scenario ${scenario.id}.`);
  }
  if (expected.maxInlineComments !== undefined && snapshot.stats.reviewComments > expected.maxInlineComments) {
    throw new Error(`Expected at most ${expected.maxInlineComments} inline comment(s) for scenario ${scenario.id}.`);
  }
  if (expected.minSuggestions !== undefined && snapshot.stats.suggestions < expected.minSuggestions) {
    throw new Error(`Expected at least ${expected.minSuggestions} suggestion(s) for scenario ${scenario.id}.`);
  }
  if (expected.compactionTriggered !== undefined && snapshot.compactionTriggered !== expected.compactionTriggered) {
    throw new Error(`Expected compactionTriggered=${expected.compactionTriggered} for scenario ${scenario.id}.`);
  }
  if (expected.prCreated !== undefined) {
    const created = snapshot.schedule?.prCreated ?? false;
    if (created !== expected.prCreated) {
      throw new Error(`Expected prCreated=${expected.prCreated} for scenario ${scenario.id}.`);
    }
  }
  if (expected.prUpdated !== undefined) {
    const updated = snapshot.schedule?.prUpdated ?? false;
    if (updated !== expected.prUpdated) {
      throw new Error(`Expected prUpdated=${expected.prUpdated} for scenario ${scenario.id}.`);
    }
  }
  if (expected.changedFilesInclude && expected.changedFilesInclude.length > 0) {
    const changed = snapshot.schedule?.changedFiles ?? [];
    for (const file of expected.changedFilesInclude) {
      if (!changed.includes(file)) {
        throw new Error(`Expected changed files to include ${file} for scenario ${scenario.id}.`);
      }
    }
  }
  if (expected.llmChanges !== undefined) {
    const llmChanges = snapshot.schedule?.llmChanges ?? false;
    if (llmChanges !== expected.llmChanges) {
      throw new Error(`Expected llmChanges=${expected.llmChanges} for scenario ${scenario.id}.`);
    }
  }
  if (expected.toolCallsInclude && expected.toolCallsInclude.length > 0) {
    const toolCalls = snapshot.schedule?.toolCalls ?? [];
    for (const tool of expected.toolCallsInclude) {
      if (!toolCalls.includes(tool)) {
        throw new Error(`Expected toolCalls to include ${tool} for scenario ${scenario.id}.`);
      }
    }
  }
}

export function buildSnapshot(
  scenario: Scenario,
  calls: Array<{ type: string; args: any }>,
  compactionTriggered: boolean
): Snapshot {
  const normalizedCalls = calls.map((call) => normalizeCall(call));
  const issueComments = normalizedCalls
    .filter((call) => call.type === "issue_comment")
    .map((call) => (call as { type: "issue_comment"; body: string }).body);
  const reviewComments = normalizedCalls
    .filter((call) => call.type === "review_comment")
    .map((call) => {
      const review = call as { type: "review_comment"; path: string; line: number; side: "LEFT" | "RIGHT"; body: string };
      return {
        path: review.path,
        line: review.line,
        side: review.side,
        body: review.body,
      };
    });
  const replies = normalizedCalls
    .filter((call) => call.type === "reply")
    .map((call) => {
      const reply = call as { type: "reply"; comment_id: number; body: string };
      return {
        comment_id: reply.comment_id,
        body: reply.body,
      };
    });

  const suggestions = reviewComments.filter((comment) => comment.body.includes("```suggestion")).length;

  return {
    id: scenario.id,
    description: scenario.description,
    mode: scenario.mode ?? "review",
    config: {
      provider: scenario.config.provider ?? "google-vertex",
      modelId: scenario.config.modelId,
      temperature: scenario.config.temperature,
      reasoning: scenario.config.reasoning ?? "low",
      maxFiles: scenario.config.maxFiles ?? 5,
      ignorePatterns: scenario.config.ignorePatterns ?? ["*.lock", "*.generated.*"],
      ...(scenario.config.contextWindow !== undefined ? { contextWindow: scenario.config.contextWindow } : {}),
      ...(scenario.config.preloadChars !== undefined ? { preloadChars: scenario.config.preloadChars } : {}),
    },
    compactionTriggered,
    issueComments,
    reviewComments,
    replies,
    stats: {
      issueComments: issueComments.length,
      reviewComments: reviewComments.length,
      replies: replies.length,
      suggestions,
    },
    calls: normalizedCalls,
  };
}

export function normalizeCall(call: { type: string; args: any }): NormalizedCall {
  if (call.type === "issue_comment") {
    return {
      type: "issue_comment",
      body: normalizeText(call.args.body),
    };
  }
  if (call.type === "review_comment") {
    return {
      type: "review_comment",
      path: call.args.path,
      line: call.args.line,
      side: call.args.side ?? "RIGHT",
      body: normalizeText(call.args.body),
    };
  }
  if (call.type === "reply") {
    return {
      type: "reply",
      comment_id: call.args.comment_id,
      body: normalizeText(call.args.body),
    };
  }
  return { type: call.type };
}

export function normalizeSnapshot(snapshot: Snapshot): Snapshot {
  const normalized: Snapshot = {
    ...snapshot,
    issueComments: snapshot.issueComments.map((body) => normalizeText(body)),
    reviewComments: snapshot.reviewComments.map((comment) => ({
      ...comment,
      body: normalizeText(comment.body),
    })),
    replies: snapshot.replies.map((reply) => ({
      ...reply,
      body: normalizeText(reply.body),
    })),
    calls: snapshot.calls.map((call) => {
      if (call.type === "issue_comment") {
        return { ...call, body: normalizeText(call.body) } as NormalizedCall;
      }
      if (call.type === "review_comment") {
        const review = call as { type: "review_comment"; path: string; line: number; side: "LEFT" | "RIGHT"; body: string };
        return { ...review, body: normalizeText(review.body) } as NormalizedCall;
      }
      if (call.type === "reply") {
        const reply = call as { type: "reply"; comment_id: number; body: string };
        return { ...reply, body: normalizeText(reply.body) } as NormalizedCall;
      }
      return call;
    }),
  };

  if (snapshot.schedule) {
    normalized.schedule = {
      ...snapshot.schedule,
      changedFiles: [...snapshot.schedule.changedFiles].sort(),
      gitCalls: [...snapshot.schedule.gitCalls],
      toolCalls: [...snapshot.schedule.toolCalls].sort(),
      assistantMessages: [...snapshot.schedule.assistantMessages],
      commandRan: snapshot.schedule.commandRan,
    };
  }

  return pruneUndefined(normalized);
}

export function normalizeText(input: string): string {
  if (!input) return "";
  return input
    .replace(/\*Billing:[^\n]*\*/g, "*Billing: <redacted>*")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n")
    .trim();
}

function pruneUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => pruneUndefined(entry)) as T;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, pruneUndefined(v)]);
    return Object.fromEntries(entries) as T;
  }
  return value;
}

async function runScheduleScenario(
  scenario: Scenario,
  apiKey: string,
  options: RunScenarioOptions
): Promise<{ snapshot: Snapshot }> {
  const { octokit, calls } = makeOctokitSpy();
  const schedule = scenario.schedule;
  if (!schedule) {
    throw new Error(`Missing schedule configuration for scenario ${scenario.id}.`);
  }
  const debug = options.debug ?? false;
  const timeoutMs = options.timeoutMs ?? 120000;
  let lastEvent = "no agent events yet";
  const debugLog = (message: string) => {
    if (debug) {
      console.log(`[llm-snapshot:${scenario.id}] ${message}`);
    }
  };
  const provider = scenario.config.provider ?? "google-vertex";
  const maxFiles = scenario.config.maxFiles ?? 5;
  const ignorePatterns = scenario.config.ignorePatterns ?? ["*.lock", "*.generated.*"];

  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sra-llm-schedule-"));
  initRepo(repoRoot, schedule.seedFiles ?? { "docs/seed.md": "seed\n" });

  const reviewConfig: ReviewConfig = {
    provider,
    apiKey,
    modelId: scenario.config.modelId,
    maxFiles,
    ignorePatterns,
    repoRoot,
    debug: false,
    reasoning: scenario.config.reasoning ?? "low",
    temperature: scenario.config.temperature,
  };

  const commandId = schedule.commandId ?? "scheduled-update";
  const actionConfig: ActionConfig = {
    review: reviewConfig,
    reviewRun: [],
    commands: [
      {
        id: commandId,
        prompt: schedule.commandPrompt,
      },
    ],
    schedule: {
      enabled: true,
      runs: { nightly: [commandId] },
      writeScope: schedule.writeScope,
    },
    toolsAllowlist: ["filesystem", "repo.write", "github.pr"],
    outputCommentType: "both",
  };

  const prevJob = process.env.GITHUB_JOB;
  const prevRepo = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_JOB = "nightly";
  process.env.GITHUB_REPOSITORY = "owner/repo";

  const gitCalls: string[] = [];
  const toolCalls: string[] = [];
  const assistantMessages: string[] = [];
  let llmChanges = false;
  let commandRan = false;
  const runGitFn = async (_repoRoot: string, args: string[]) => {
    gitCalls.push(args.join(" "));
    if (args[0] === "push") return;
    execFileSync("git", args, { cwd: repoRoot });
  };

  let prCreated = false;
  let prUpdated = false;
  const scheduleOctokit = {
    ...octokit,
    rest: {
      ...octokit.rest,
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => {
          prCreated = true;
          return { data: { number: 42 } };
        },
        update: async () => {
          prUpdated = true;
          return { data: { number: 42 } };
        },
      },
    },
  };

  let lastAgent: any = null;
  const runCommandFn = async (input: any) => {
    commandRan = true;
    await runCommand({
      ...input,
      overrides: {
        agentFactory: ({ initialState, transformContext, getApiKey, streamFn }: any) => {
          const agent = new Agent({
            initialState,
            transformContext,
            getApiKey,
            streamFn,
          });
          lastAgent = agent;
          agent.subscribe((event: any) => {
            if (event.type === "tool_execution_start") {
              toolCalls.push(event.toolName);
              lastEvent = `tool:${event.toolName}`;
              debugLog(`tool ${event.toolName}`);
            }
            if (event.type === "tool_execution_end") {
              lastEvent = `tool_end:${event.toolName}`;
              debugLog(`tool end ${event.toolName}`);
            }
            if (event.type === "tool_execution_error") {
              lastEvent = `tool_error:${event.toolName}`;
              debugLog(`tool error ${event.toolName}`);
            }
            if (event.type === "message_end" && event.message?.role === "assistant") {
              const text = (event.message.content ?? [])
                .filter((part: any) => part.type === "text")
                .map((part: any) => part.text)
                .join("");
              if (text.trim()) {
                assistantMessages.push(text.trim());
                lastEvent = `assistant:${text.trim().slice(0, 120)}`;
                debugLog(`assistant ${text.trim().slice(0, 120)}`);
              }
            }
          });
          return agent;
        },
      },
    });
    if (assistantMessages.length === 0 && lastAgent?.state?.messages) {
      const messages = lastAgent.state.messages as any[];
      for (const message of messages) {
        if (message?.role === "assistant") {
          const text = Array.isArray(message.content)
            ? message.content.map((part: any) => part.text ?? "").join("")
            : typeof message.content === "string"
              ? message.content
              : "";
          if (text.trim()) {
            assistantMessages.push(text.trim());
          }
        }
      }
    }
    llmChanges = listDiffFiles(repoRoot, "main").length > 0;
  };

  try {
    await withTimeout(
      `runScheduledFlow:${scenario.id}`,
      runScheduledFlow({
        config: actionConfig,
        octokit: scheduleOctokit as any,
        runGitFn,
        runCommandFn,
        getCurrentBranchFn: async () => "main",
        logInfo: () => {},
    }),
    timeoutMs,
    () => {
      const toolTail = toolCalls.slice(-5).join(",");
      const gitTail = gitCalls.slice(-5).join(" | ");
      const assistantTail = assistantMessages.slice(-2).map((msg) => msg.slice(0, 120)).join(" | ");
      return formatTimeoutInfo([
        ["lastEvent", lastEvent],
        ["toolTail", toolTail],
        ["gitTail", gitTail],
        ["assistantTail", assistantTail],
        ["commandRan", commandRan ? "yes" : undefined],
      ]);
    }
  );
  } finally {
    restoreEnv(prevJob, prevRepo);
  }

  const changedFiles = listDiffFiles(repoRoot, "main");
  const snapshot = buildSnapshot(scenario, calls, false);
  snapshot.mode = "schedule";
  snapshot.schedule = {
    prCreated,
    prUpdated,
    changedFiles,
    gitCalls,
    toolCalls,
    llmChanges,
    assistantMessages,
    commandRan,
  };
  return { snapshot };
}

function initRepo(repoRoot: string, seedFiles: Record<string, string>) {
  execFileSync("git", ["init"], { cwd: repoRoot });
  execFileSync("git", ["checkout", "-b", "main"], { cwd: repoRoot });
  for (const [file, content] of Object.entries(seedFiles)) {
    const filePath = path.join(repoRoot, file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
  }
  execFileSync("git", ["add", "-A"], { cwd: repoRoot });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "init"], {
    cwd: repoRoot,
  });
}

function listChangedFiles(repoRoot: string): string[] {
  const output = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot }).toString();
  const lines = output.trimEnd().split(/\r?\n/).filter(Boolean);
  return lines
    .map((line) => {
      const entry = line.slice(3).trim();
      if (!entry) return "";
      if (entry.includes(" -> ")) {
        const parts = entry.split(" -> ").map((part) => part.trim());
        return parts[1] ?? parts[0];
      }
      return entry;
    })
    .filter(Boolean);
}

function listDiffFiles(repoRoot: string, baseRef: string): string[] {
  const output = execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], { cwd: repoRoot }).toString();
  return output
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function applyFallbackWrites(repoRoot: string) {
  const autoPath = path.join(repoRoot, "docs", "auto.md");
  const seedPath = path.join(repoRoot, "docs", "seed.md");
  fs.mkdirSync(path.dirname(autoPath), { recursive: true });
  fs.writeFileSync(
    autoPath,
    "Automated update: this file was generated during a scheduled run.\n",
    "utf8"
  );
  fs.writeFileSync(seedPath, "seed\nAutomated update applied.\n", "utf8");
}

function restoreEnv(job?: string, repo?: string) {
  if (job === undefined) {
    delete process.env.GITHUB_JOB;
  } else {
    process.env.GITHUB_JOB = job;
  }
  if (repo === undefined) {
    delete process.env.GITHUB_REPOSITORY;
  } else {
    process.env.GITHUB_REPOSITORY = repo;
  }
}

async function withTimeout<T>(
  label: string,
  promise: Promise<T>,
  timeoutMs: number,
  getDebugInfo?: () => string
): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      const info = getDebugInfo ? getDebugInfo() : "";
      if (info) {
        console.error(`[llm-snapshot-timeout] ${label} ${info}`);
      }
      reject(new Error(`${label} timed out after ${timeoutMs}ms${info ? ` (${info})` : ""}.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
