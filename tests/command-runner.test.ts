import { test, expect } from "bun:test";
import { runCommand } from "../src/commands/run.ts";
import type { ReviewConfig, ReviewContext, PullRequestInfo, ChangedFile, CommandDefinition } from "../src/types.ts";
import { makeOctokitSpy } from "./helpers/fake-octokit.ts";

const baseConfig: ReviewConfig = {
  provider: "google",
  apiKey: "test",
  modelId: "model",
  maxFiles: 10,
  ignorePatterns: [],
  repoRoot: process.cwd(),
  debug: false,
  reasoning: "off",
};

const baseContext: ReviewContext = { owner: "o", repo: "r", prNumber: 1 };
const basePrInfo: PullRequestInfo = {
  number: 1,
  title: "PR",
  body: "",
  author: "author",
  baseRef: "main",
  headRef: "feature",
  baseSha: "base",
  headSha: "head",
  url: "https://example.com/pr/1",
};
const baseFiles: ChangedFile[] = [
  { filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch: "@@ -1 +1 @@\n-const a=1;\n+const a=2;\n" },
];

const command: CommandDefinition = { id: "security", prompt: "Check" };

test("runCommand filters review tools for issue-only", async () => {
  const { octokit } = makeOctokitSpy();
  let toolNames: string[] = [];
  await runCommand({
    mode: "pr",
    command,
    config: baseConfig,
    context: baseContext,
    octokit: octokit as any,
    prInfo: basePrInfo,
    changedFiles: baseFiles,
    existingComments: [],
    reviewThreads: [],
    commentType: "issue",
    allowlist: ["filesystem", "git.read", "github.pr.read", "github.pr.feedback"],
    overrides: {
      model: { contextWindow: 1000 } as any,
      compactionModel: null,
      agentFactory: ({ initialState }: any) => {
        toolNames = initialState.tools.map((tool: any) => tool.name);
        return {
          state: { error: null, messages: [] },
          subscribe() {},
          async prompt() {},
          abort() {},
        };
      },
    },
  });
  expect(toolNames).toContain("post_summary");
  expect(toolNames).not.toContain("comment");
});

test("runCommand filters review tools for review-only", async () => {
  const { octokit } = makeOctokitSpy();
  let toolNames: string[] = [];
  await runCommand({
    mode: "pr",
    command,
    config: baseConfig,
    context: baseContext,
    octokit: octokit as any,
    prInfo: basePrInfo,
    changedFiles: baseFiles,
    existingComments: [],
    reviewThreads: [],
    commentType: "review",
    allowlist: ["filesystem", "git.read", "github.pr.read", "github.pr.feedback"],
    overrides: {
      model: { contextWindow: 1000 } as any,
      compactionModel: null,
      agentFactory: ({ initialState }: any) => {
        toolNames = initialState.tools.map((tool: any) => tool.name);
        return {
          state: { error: null, messages: [] },
          subscribe() {},
          async prompt() {},
          abort() {},
        };
      },
    },
  });
  expect(toolNames).toContain("comment");
  expect(toolNames).not.toContain("post_summary");
});

test("runCommand exposes PR tools when allowPrToolsInReview is true", async () => {
  const { octokit } = makeOctokitSpy();
  let toolNames: string[] = [];
  await runCommand({
    mode: "pr",
    command,
    config: { ...baseConfig, allowPrToolsInReview: true },
    context: baseContext,
    octokit: octokit as any,
    prInfo: basePrInfo,
    changedFiles: baseFiles,
    existingComments: [],
    reviewThreads: [],
    commentType: "issue",
    allowlist: ["filesystem", "git.read", "github.pr.read", "github.pr.feedback", "github.pr.manage"],
    overrides: {
      model: { contextWindow: 1000 } as any,
      compactionModel: null,
      agentFactory: ({ initialState }: any) => {
        toolNames = initialState.tools.map((tool: any) => tool.name);
        return {
          state: { error: null, messages: [] },
          subscribe() {},
          async prompt() {},
          abort() {},
        };
      },
    },
  });
  expect(toolNames).toContain("commit_changes");
  expect(toolNames).toContain("push_pr");
});

test("runCommand logs assistant thinking when debug is enabled", async () => {
  const { octokit } = makeOctokitSpy();
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    let subscriber: ((event: any) => void) | null = null;
    await runCommand({
      mode: "schedule",
      command,
      config: { ...baseConfig, debug: true },
      schedule: { enabled: true },
      scheduleContext: {
        jobId: "nightly",
        commandIds: ["security"],
        owner: "o",
        repo: "r",
        octokit: octokit as any,
      },
      commentType: "issue",
      allowlist: [],
      overrides: {
        model: { contextWindow: 1000 } as any,
        compactionModel: null,
        agentFactory: () => ({
          state: { error: null, messages: [] },
          subscribe(fn: (event: any) => void) {
            subscriber = fn;
          },
          async prompt() {
            subscriber?.({
              type: "message_end",
              message: {
                role: "assistant",
                content: [
                  { type: "thinking", thinking: "debug-thoughts" },
                  { type: "text", text: "done" },
                ],
              },
            });
          },
          abort() {},
        }),
      },
    });
  } finally {
    console.log = originalLog;
  }
  expect(logs.some((line) => line.includes("assistant thinking: debug-thoughts"))).toBe(true);
  expect(logs.some((line) => line.includes("assistant: done"))).toBe(true);
});
