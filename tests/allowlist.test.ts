import { test, expect } from "bun:test";
import { runReview } from "../src/agent.ts";
import type { ChangedFile, ReviewConfig, ReviewContext, PullRequestInfo } from "../src/types.ts";
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

test("runReview filters tools by allowlist", async () => {
  const { octokit } = makeOctokitSpy();
  let toolNames: string[] = [];

  const agentFactory = ({ initialState }: any) => {
    toolNames = initialState.tools.map((tool: any) => tool.name);
    const summaryTool = initialState.tools.find((tool: any) => tool.name === "post_summary");
    return {
      state: { error: null, messages: [] },
      subscribe() {},
      async prompt() {
        if (summaryTool) {
          await summaryTool.execute("", {
            body: "## Review Summary\n\n**Verdict:** Approve\n\n### Issues Found\n\n- None\n\n### Key Findings\n\n- None",
          });
        }
      },
      abort() {},
    };
  };

  await runReview({
    config: baseConfig,
    context: baseContext,
    octokit: octokit as any,
    prInfo: basePrInfo,
    changedFiles: baseChangedFiles,
    existingComments: [],
    reviewThreads: [],
    toolAllowlist: ["filesystem", "github.pr.feedback"],
    overrides: {
      model: { contextWindow: 1000 } as any,
      compactionModel: null,
      agentFactory,
    },
  });

  expect(toolNames).toContain("read");
  expect(toolNames).toContain("post_summary");
  expect(toolNames).not.toContain("get_diff");
});

test("runReview includes subagent tool when allowlisted", async () => {
  const { octokit } = makeOctokitSpy();
  let toolNames: string[] = [];

  const agentFactory = ({ initialState }: any) => {
    toolNames = initialState.tools.map((tool: any) => tool.name);
    const summaryTool = initialState.tools.find((tool: any) => tool.name === "post_summary");
    return {
      state: { error: null, messages: [] },
      subscribe() {},
      async prompt() {
        if (summaryTool) {
          await summaryTool.execute("", {
            body: "## Review Summary\n\n**Verdict:** Approve\n\n### Issues Found\n\n- None\n\n### Key Findings\n\n- None",
          });
        }
      },
      abort() {},
    };
  };

  await runReview({
    config: baseConfig,
    context: baseContext,
    octokit: octokit as any,
    prInfo: basePrInfo,
    changedFiles: baseChangedFiles,
    existingComments: [],
    reviewThreads: [],
    toolAllowlist: ["filesystem", "github.pr.feedback", "agent.subagent"],
    overrides: {
      model: { contextWindow: 1000 } as any,
      compactionModel: null,
      agentFactory,
    },
  });

  expect(toolNames).toContain("subagent");
});

test("runReview subagent uses allowlisted tools only", async () => {
  const { octokit } = makeOctokitSpy();
  let subagentTools: string[] = [];

  const agentFactory = ({ initialState }: any) => {
    const systemPrompt = initialState.systemPrompt as string;
    if (systemPrompt.includes("subagent invoked by another agent")) {
      subagentTools = initialState.tools.map((tool: any) => tool.name);
      let subscriber: (event: any) => void = () => {};
      return {
        state: { error: null, messages: [] },
        subscribe(fn: (event: any) => void) {
          subscriber = fn;
        },
        async prompt() {
          subscriber({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Subagent ok" }],
            },
          });
        },
        abort() {},
      };
    }

    const subagentTool = initialState.tools.find((tool: any) => tool.name === "subagent");
    return {
      state: { error: null, messages: [] },
      subscribe() {},
      async prompt() {
        if (subagentTool) {
          await subagentTool.execute("tool-call-id", { task: "Check tools" });
        }
      },
      abort() {},
    };
  };

  await runReview({
    config: baseConfig,
    context: baseContext,
    octokit: octokit as any,
    prInfo: basePrInfo,
    changedFiles: baseChangedFiles,
    existingComments: [],
    reviewThreads: [],
    toolAllowlist: ["filesystem", "agent.subagent"],
    overrides: {
      model: { contextWindow: 1000 } as any,
      compactionModel: null,
      agentFactory,
    },
  });

  expect(subagentTools).toContain("read");
  expect(subagentTools).not.toContain("get_pr_info");
  expect(subagentTools).not.toContain("comment");
});

test("runReview skips fallback summary when feedback tools are disallowed", async () => {
  const { octokit, calls } = makeOctokitSpy();

  const agentFactory = () => ({
    state: { error: null, messages: [] },
    subscribe() {},
    async prompt() {},
    abort() {},
  });

  await runReview({
    config: baseConfig,
    context: baseContext,
    octokit: octokit as any,
    prInfo: basePrInfo,
    changedFiles: baseChangedFiles,
    existingComments: [],
    reviewThreads: [],
    toolAllowlist: ["filesystem"],
    overrides: {
      model: { contextWindow: 1000 } as any,
      compactionModel: null,
      agentFactory,
    },
  });

  expect(calls.some((call) => call.type === "issue_comment")).toBe(false);
});
