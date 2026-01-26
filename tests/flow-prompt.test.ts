import { test, expect } from "bun:test";
import { runActionFlow } from "../src/app/flow.ts";
import { buildUserPrompt } from "../src/prompt.ts";
import type { ReviewConfig, ReviewContext } from "../src/types.ts";

const config: ReviewConfig = {
  provider: "google",
  apiKey: "test",
  modelId: "model",
  maxFiles: 5,
  ignorePatterns: ["**/*.snap"],
  repoRoot: process.cwd(),
  debug: false,
  reasoning: "off",
};

const context: ReviewContext = {
  owner: "owner",
  repo: "repo",
  prNumber: 42,
};

test("runActionFlow prompt snapshot matches fixture", async () => {
  const fixture = await Bun.file("tests/fixtures/harness/flow-prompt.json").json();

  let captured: any = null;
  await runActionFlow({
    config,
    context,
    octokit: {} as any,
    fetchPrDataFn: async () => ({ prInfo: fixture.prInfo, changedFiles: fixture.changedFiles }),
    fetchExistingCommentsFn: async () => ({ existingComments: fixture.existingComments, reviewThreads: [] }),
    fetchChangesSinceReviewFn: async () => ({ files: fixture.changedFiles, warning: null }),
    runReviewFn: async (input) => {
      captured = input;
    },
  });

  expect(captured).not.toBeNull();
  const directoryCount = new Set(captured.changedFiles.map((file: any) => file.filename.split("/").slice(0, -1).join("/") || "(root)")).size;
  const prompt = buildUserPrompt({
    prTitle: captured.prInfo.title,
    prBody: captured.prInfo.body,
    changedFiles: captured.changedFiles.map((file: any) => file.filename),
    directoryCount,
    maxFiles: config.maxFiles,
    ignorePatterns: config.ignorePatterns,
    existingComments: captured.existingComments.length,
    lastReviewedSha: captured.lastReviewedSha,
    headSha: captured.prInfo.headSha,
    scopeWarning: captured.scopeWarning ?? null,
    previousVerdict: captured.previousVerdict ?? null,
    previousReviewUrl: captured.previousReviewUrl ?? null,
    previousReviewAt: captured.previousReviewAt ?? null,
    previousReviewBody: captured.previousReviewBody ?? null,
    sequenceDiagram: null,
  });

  const expected = await Bun.file("tests/fixtures/harness/flow-prompt.golden.txt").text();
  expect(prompt).toBe(expected);
});
