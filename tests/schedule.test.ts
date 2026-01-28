import { test, expect } from "bun:test";
import { runScheduledFlow, buildScheduleBranchName } from "../src/app/schedule.ts";
import type { ActionConfig, ReviewConfig } from "../src/types.ts";

const baseReview: ReviewConfig = {
  provider: "google",
  apiKey: "test",
  modelId: "model",
  maxFiles: 50,
  ignorePatterns: [],
  repoRoot: process.cwd(),
  debug: false,
  reasoning: "off",
};

const baseConfig: ActionConfig = {
  review: baseReview,
  reviewRun: [],
  commands: [],
  schedule: {
    enabled: true,
    runs: {},
  },
  toolsAllowlist: ["filesystem", "git.read", "git.history", "github.read", "github.write", "repo.write"],
  outputCommentType: "both",
};

test("runScheduledFlow no-ops when job id missing", async () => {
  const previous = process.env.GITHUB_JOB;
  process.env.GITHUB_JOB = "nightly";
  let message = "";
  let ran = false;
  await runScheduledFlow({
    config: {
      ...baseConfig,
      schedule: { enabled: true, runs: { other: ["cmd"] } },
    },
    octokit: {} as any,
    runCommandFn: async () => {
      ran = true;
    },
    logInfo: (msg) => {
      message = msg;
    },
  });
  expect(ran).toBe(false);
  expect(message).toContain("No schedule.runs mapping");
  if (previous === undefined) {
    delete process.env.GITHUB_JOB;
  } else {
    process.env.GITHUB_JOB = previous;
  }
});

test("buildScheduleBranchName is deterministic", () => {
  const name1 = buildScheduleBranchName("job", ["docs-drift"]);
  const name2 = buildScheduleBranchName("job", ["docs-drift"]);
  expect(name1).toBe(name2);
  expect(name1).toContain("docs-drift");
});
