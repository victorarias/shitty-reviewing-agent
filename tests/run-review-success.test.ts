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

test("runReview success path posts summary via tool", async () => {
  const { octokit, calls } = makeOctokitSpy();

  const agentFactory = ({ initialState }: any) => {
    const tools = initialState.tools as Array<any>;
    const summaryTool = tools.find((tool) => tool.name === "post_summary");
    if (!summaryTool) {
      throw new Error("Missing post_summary tool");
    }

    return {
      state: { error: null, messages: [] },
      subscribe() {},
      async prompt() {
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

  expect(calls.length).toBe(1);
  expect(calls[0].type).toBe("issue_comment");
  expect(calls[0].args.body).toContain("**Verdict:** Approve");
  expect(calls[0].args.body).toContain("Reviewed by shitty-reviewing-agent");
});

test("runReview executes experimental PR explainer when enabled", async () => {
  const { octokit, calls } = makeOctokitSpy();
  const config: ReviewConfig = {
    ...baseConfig,
    experimentalPrExplainer: true,
  };

  const agentFactory = ({ initialState }: any) => {
    const tools = initialState.tools as Array<any>;
    const summaryTool = tools.find((tool) => tool.name === "post_summary");
    if (!summaryTool) {
      throw new Error("Missing post_summary tool");
    }
    return {
      state: { error: null, messages: [] },
      subscribe() {},
      async prompt() {
        await summaryTool.execute("", {
          body: "## Review Summary\n\n**Verdict:** Approve\n\n### Issues Found\n\n- None\n\n### Key Findings\n\n- None",
        });
      },
      abort() {},
    };
  };

  await runReview({
    config,
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
      prExplainerGenerateFn: async () => ({
        reviewGuide: "## Review Guide\n\nStart with the changed entrypoint.",
        fileComments: [{ path: "src/index.ts", body: "### What this file does\n- Entrypoint overview." }],
      }),
    },
  });

  expect(calls.length).toBe(3);
  expect(calls[0].type).toBe("issue_comment");
  expect(calls[0].args.body).toContain("sri:review-guide");
  expect(calls[1].type).toBe("review_comment");
  expect(calls[1].args.path).toBe("src/index.ts");
  expect(calls[2].type).toBe("issue_comment");
  expect(calls[2].args.body).toContain("**Verdict:** Approve");
});
