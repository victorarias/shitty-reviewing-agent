import { test, expect } from "bun:test";
import { runReview } from "../src/agent.ts";
import type { ChangedFile, ReviewConfig, ReviewContext, PullRequestInfo } from "../src/types.ts";
import { createFakeAgent } from "./helpers/fake-agent.ts";
import { makeOctokitSpy } from "./helpers/fake-octokit.ts";

const baseConfig: ReviewConfig = {
  provider: "google",
  apiKey: "test",
  modelId: "model",
  maxFiles: 1,
  ignorePatterns: [],
  repoRoot: process.cwd(),
  debug: false,
  reasoning: "off",
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

test("runReview posts fallback summary when agent produces no summary", async () => {
  const { octokit, calls } = makeOctokitSpy();
  const fakeAgent = createFakeAgent();

  await runReview({
    config: baseConfig,
    context: baseContext,
    octokit: octokit as any,
    prInfo: basePrInfo,
    changedFiles: baseChangedFiles,
    existingComments: [],
    reviewThreads: [],
    overrides: {
      model: { contextWindow: 1000 } as any,
      compactionModel: null,
      agentFactory: () => fakeAgent,
    },
  });

  expect(calls.length).toBe(1);
  expect(calls[0].type).toBe("issue_comment");
  expect(calls[0].args.body).toContain("Agent failed to produce a review summary.");
  expect(calls[0].args.body).toContain("## Review Summary");
});

test("runReview uses iteration-limit reason when tool executions exceed", async () => {
  const { octokit, calls } = makeOctokitSpy();
  const events = Array.from({ length: 15 }, () => ({
    type: "tool_execution_start",
    toolName: "read",
    args: { path: "src/index.ts" },
  }));
  const fakeAgent = createFakeAgent({ events, abortError: null });

  await runReview({
    config: baseConfig,
    context: baseContext,
    octokit: octokit as any,
    prInfo: basePrInfo,
    changedFiles: baseChangedFiles,
    existingComments: [],
    reviewThreads: [],
    overrides: {
      model: { contextWindow: 1000 } as any,
      compactionModel: null,
      agentFactory: () => fakeAgent,
    },
  });

  expect(calls.length).toBe(1);
  expect(calls[0].args.body).toContain("Agent exceeded iteration limit before posting summary.");
});
