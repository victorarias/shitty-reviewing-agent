import { test, expect } from "bun:test";
import { runActionFlow } from "../src/app/flow.ts";
import type { ActionConfig, ReviewConfig, ReviewContext } from "../src/types.ts";

const baseConfig: ReviewConfig = {
  provider: "google",
  apiKey: "test",
  modelId: "model",
  maxFiles: 5,
  ignorePatterns: ["**/*.snap"],
  repoRoot: process.cwd(),
  debug: false,
  reasoning: "off",
};

const actionConfig: ActionConfig = {
  review: baseConfig,
  reviewRun: [],
  commands: [],
  toolsAllowlist: [],
  outputCommentType: "both",
};

const context: ReviewContext = {
  owner: "owner",
  repo: "repo",
  prNumber: 99,
};

test("runActionFlow skips large PR after ignore filtering", async () => {
  const fixture = await Bun.file("tests/fixtures/harness/flow-skip.json").json();
  let skipped = false;
  await runActionFlow({
    config: actionConfig,
    context,
    octokit: {} as any,
    fetchPrDataFn: async () => ({ prInfo: fixture.prInfo, changedFiles: fixture.changedFiles }),
    fetchExistingCommentsFn: async () => ({ existingComments: [], reviewThreads: [] }),
    postSkipSummaryFn: async (_octokit, _context, _modelId, fileCount, maxFiles) => {
      skipped = true;
      expect(fileCount).toBe(7);
      expect(maxFiles).toBe(5);
    },
    runReviewFn: async () => {
      throw new Error("runReview should not be called");
    },
  });

  expect(skipped).toBe(true);
});
