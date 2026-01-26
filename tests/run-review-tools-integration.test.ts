import { test, expect } from "bun:test";
import { runReview } from "../src/agent.ts";
import type { ChangedFile, ReviewConfig, ReviewContext, PullRequestInfo } from "../src/types.ts";
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

const patch = "@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n";

const baseChangedFiles: ChangedFile[] = [
  {
    filename: "src/index.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    patch,
  },
];

test("runReview tool integration posts comment and suggestion", async () => {
  const { octokit, calls } = makeOctokitSpy();

  const agentFactory = ({ initialState }: any) => {
    const tools = initialState.tools as Array<any>;
    const commentTool = tools.find((tool) => tool.name === "comment");
    const suggestTool = tools.find((tool) => tool.name === "suggest");
    const summaryTool = tools.find((tool) => tool.name === "post_summary");
    if (!commentTool || !suggestTool || !summaryTool) {
      throw new Error("Missing comment/suggest/summary tools");
    }

    return {
      state: { error: null, messages: [] },
      subscribe() {},
      async prompt() {
        await commentTool.execute("", {
          path: "src/index.ts",
          line: 1,
          side: "RIGHT",
          body: "Inline feedback",
        });
        await suggestTool.execute("", {
          path: "src/index.ts",
          line: 1,
          side: "RIGHT",
          comment: "Try this",
          suggestion: "const a = 3;",
        });
        await summaryTool.execute("", {
          body: "## Review Summary\n\n**Verdict:** Approve\n\n### Issues Found\n\n- None\n\n### Key Findings\n\n- None",
        });
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
    overrides: {
      model: { contextWindow: 1000 } as any,
      compactionModel: null,
      agentFactory,
    },
  });

  expect(calls.length).toBe(3);
  expect(calls[0].type).toBe("review_comment");
  expect(calls[0].args.body).toContain("Inline feedback");
  expect(calls[1].type).toBe("review_comment");
  expect(calls[1].args.body).toContain("```suggestion");
  expect(calls[2].type).toBe("issue_comment");
});
