import { test, expect } from "bun:test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runScheduledFlow } from "../src/app/schedule.ts";
import { buildScheduleBranchName } from "../src/app/schedule-utils.ts";
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
  toolsAllowlist: ["filesystem", "git.read", "git.history", "github.read", "github.write", "github.pr", "repo.write"],
  outputCommentType: "both",
};

test("runScheduledFlow no-ops when job id missing", async () => {
  const previous = process.env.GITHUB_JOB;
  const prevRepo = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_JOB = "nightly";
  process.env.GITHUB_REPOSITORY = "owner/repo";
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
  if (prevRepo === undefined) {
    delete process.env.GITHUB_REPOSITORY;
  } else {
    process.env.GITHUB_REPOSITORY = prevRepo;
  }
});

test("buildScheduleBranchName is deterministic", () => {
  const name1 = buildScheduleBranchName("job", ["docs-drift"]);
  const name2 = buildScheduleBranchName("job", ["docs-drift"]);
  expect(name1).toBe(name2);
  expect(name1).toContain("docs-drift");
});

test("runScheduledFlow honors branch conditions", async () => {
  const prevJob = process.env.GITHUB_JOB;
  const prevRepo = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_JOB = "nightly";
  process.env.GITHUB_REPOSITORY = "owner/repo";
  let message = "";
  await runScheduledFlow({
    config: {
      ...baseConfig,
      schedule: {
        enabled: true,
        runs: { nightly: ["cmd"] },
        conditions: { branch: { include: ["main"] } },
      },
      commands: [{ id: "cmd", prompt: "Do work" }],
    },
    octokit: fakeOctokit(),
    runCommandFn: async () => {},
    logInfo: (msg) => {
      message = msg;
    },
    getCurrentBranchFn: async () => "feature",
  });
  expect(message).toContain("Schedule conditions blocked run on branch");
  restoreEnv(prevJob, prevRepo);
});

test("runScheduledFlow does not create PR without tool calls", async () => {
  const prevJob = process.env.GITHUB_JOB;
  const prevRepo = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_JOB = "nightly";
  process.env.GITHUB_REPOSITORY = "owner/repo";

  const calls: string[] = [];
  const octokit = fakeOctokit({
    list: async () => ({ data: [] }),
    create: async () => {
      calls.push("create");
      return { data: { number: 123 } };
    },
    update: async () => {
      calls.push("update");
      return { data: { number: 123 } };
    },
  });

  await runScheduledFlow({
    config: {
      ...baseConfig,
      schedule: {
        enabled: true,
        runs: { nightly: ["cmd"] },
      },
      commands: [{ id: "cmd", prompt: "Do work" }],
    },
    octokit,
    runCommandFn: async () => {},
    getCurrentBranchFn: async () => "main",
  });

  expect(calls).toEqual([]);
  restoreEnv(prevJob, prevRepo);
});

test("runScheduledFlow uses ref name when HEAD is detached", async () => {
  const prevJob = process.env.GITHUB_JOB;
  const prevRepo = process.env.GITHUB_REPOSITORY;
  const prevRefName = process.env.GITHUB_REF_NAME;
  process.env.GITHUB_JOB = "nightly";
  process.env.GITHUB_REPOSITORY = "owner/repo";
  process.env.GITHUB_REF_NAME = "main";
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sra-schedule-"));
  execSync("git init", { cwd: repoRoot, stdio: "ignore" });
  execSync("git checkout -b main", { cwd: repoRoot, stdio: "ignore" });
  execSync("git -c user.name=test -c user.email=test@example.com commit --allow-empty -m init", {
    cwd: repoRoot,
    stdio: "ignore",
  });
  execSync("git checkout --detach", { cwd: repoRoot, stdio: "ignore" });

  const messages: string[] = [];
  await runScheduledFlow({
    config: {
      ...baseConfig,
      review: { ...baseReview, repoRoot },
      schedule: {
        enabled: true,
        runs: { nightly: ["cmd"] },
        conditions: { branch: { include: ["main"] } },
      },
      commands: [{ id: "cmd", prompt: "Do work" }],
    },
    octokit: fakeOctokit(),
    runCommandFn: async () => {},
    logInfo: (msg) => {
      messages.push(msg);
    },
  });

  expect(messages.join("\n")).not.toContain("blocked run on branch");
  restoreEnv(prevJob, prevRepo);
  if (prevRefName === undefined) {
    delete process.env.GITHUB_REF_NAME;
  } else {
    process.env.GITHUB_REF_NAME = prevRefName;
  }
});

function fakeOctokit(overrides?: Partial<any>) {
  return {
    rest: {
      pulls: {
        list: overrides?.list ?? (async () => ({ data: [] })),
        create: overrides?.create ?? (async () => ({ data: { number: 1 } })),
        update: overrides?.update ?? (async () => ({ data: { number: 1 } })),
      },
    },
  } as any;
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
