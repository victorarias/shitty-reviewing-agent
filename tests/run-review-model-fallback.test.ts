import { test, expect, beforeEach, afterEach } from "bun:test";
import { runReview } from "../src/agent.ts";
import type { ChangedFile, ModelEndpoint, ReviewConfig, ReviewContext, PullRequestInfo } from "../src/types.ts";
import { makeOctokitSpy } from "./helpers/fake-octokit.ts";

const baseConfig: ReviewConfig = {
  provider: "google-vertex",
  apiKey: "test",
  modelId: "gemini-pro",
  maxFiles: 1,
  ignorePatterns: [],
  repoRoot: process.cwd(),
  debug: false,
  reasoning: "off",
};

const fallbackEndpoint: ModelEndpoint = {
  provider: "openrouter",
  modelId: "anthropic/claude-sonnet-4",
  apiKey: "fallback-key",
};

const baseContext: ReviewContext = {
  owner: "owner",
  repo: "repo",
  prNumber: 1,
};

const basePrInfo: PullRequestInfo = {
  number: 1,
  title: "Test PR",
  body: "",
  author: "tester",
  baseRef: "main",
  headRef: "feature",
  baseSha: "base",
  headSha: "head",
  url: "https://example.com/pr/1",
};

const baseChangedFiles: ChangedFile[] = [
  {
    filename: "src/index.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: "@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;\n",
  },
];

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.LLM_FALLBACK_AFTER_QUOTA_ERRORS;
  // Threshold of 1 means QuotaExhaustedError fires on first 429 — no real sleeps.
  process.env.LLM_FALLBACK_AFTER_QUOTA_ERRORS = "1";
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env.LLM_FALLBACK_AFTER_QUOTA_ERRORS;
  } else {
    process.env.LLM_FALLBACK_AFTER_QUOTA_ERRORS = savedEnv;
  }
});

function createQuotaErrorAgent() {
  const subscribers: Array<(event: any) => void> = [];
  return {
    state: { error: null, messages: [] },
    subscribe(fn: (event: any) => void) { subscribers.push(fn); },
    async prompt() {
      const err = new Error("429 Resource exhausted");
      (err as any).status = 429;
      throw err;
    },
    abort() {},
  };
}

function createSuccessAgent() {
  const subscribers: Array<(event: any) => void> = [];
  return {
    state: { error: null, messages: [] },
    subscribe(fn: (event: any) => void) { subscribers.push(fn); },
    async prompt() {
      for (const handler of subscribers) {
        handler({ type: "agent_end" });
      }
    },
    abort() {},
  };
}

test("fallback model is used when primary hits quota exhaustion", async () => {
  const { octokit, calls } = makeOctokitSpy();
  let agentCount = 0;

  await runReview({
    config: { ...baseConfig, fallback: fallbackEndpoint },
    context: baseContext,
    octokit: octokit as any,
    prInfo: basePrInfo,
    changedFiles: baseChangedFiles,
    existingComments: [],
    reviewThreads: [],
    overrides: {
      model: { contextWindow: 1000 } as any,
      compactionModel: null,
      agentFactory: () => {
        agentCount += 1;
        // First agent (primary) always throws 429
        if (agentCount === 1) return createQuotaErrorAgent();
        // Second agent (fallback) succeeds
        return createSuccessAgent();
      },
    },
  });

  expect(agentCount).toBe(2);
  // Fallback agent succeeded → fallback summary posted (no review summary from agent)
  expect(calls.length).toBe(1);
  expect(calls[0].args.body).toContain("## Review Summary");
});

test("failure summary references fallback model when fallback also fails", async () => {
  const { octokit, calls } = makeOctokitSpy();
  let agentCount = 0;

  await expect(
    runReview({
      config: { ...baseConfig, fallback: fallbackEndpoint },
      context: baseContext,
      octokit: octokit as any,
      prInfo: basePrInfo,
      changedFiles: baseChangedFiles,
      existingComments: [],
      reviewThreads: [],
      overrides: {
        model: { contextWindow: 1000 } as any,
        compactionModel: null,
        agentFactory: () => {
          agentCount += 1;
          // Both primary and fallback throw non-retryable errors
          if (agentCount === 1) return createQuotaErrorAgent();
          // Fallback also fails (non-quota error)
          const subscribers: Array<(event: any) => void> = [];
          return {
            state: { error: null, messages: [] },
            subscribe(fn: (event: any) => void) { subscribers.push(fn); },
            async prompt() { throw new Error("model not found"); },
            abort() {},
          };
        },
      },
    })
  ).rejects.toThrow("model not found");

  expect(agentCount).toBe(2);
  // Failure summary should reference the fallback model
  expect(calls.length).toBe(1);
  const body = calls[0].args.body;
  expect(body).toContain("LLM request failed after retries (fallback: anthropic/claude-sonnet-4)");
});

test("no fallback configured propagates quota error as normal failure", async () => {
  const { octokit, calls } = makeOctokitSpy();

  // Without LLM_FALLBACK_AFTER_QUOTA_ERRORS=1 and no fallback, withRetries would
  // use the normal time budget. But since we set the env var in beforeEach,
  // QuotaExhaustedError fires — and without a fallback, it falls through as a
  // normal error with "LLM request failed after retries."
  await expect(
    runReview({
      config: baseConfig, // no fallback
      context: baseContext,
      octokit: octokit as any,
      prInfo: basePrInfo,
      changedFiles: baseChangedFiles,
      existingComments: [],
      reviewThreads: [],
      overrides: {
        model: { contextWindow: 1000 } as any,
        compactionModel: null,
        agentFactory: () => createQuotaErrorAgent(),
      },
    })
  ).rejects.toThrow();

  expect(calls.length).toBe(1);
  expect(calls[0].args.body).toContain("LLM request failed after retries");
});
