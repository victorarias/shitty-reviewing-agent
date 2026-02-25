import { test, expect } from "bun:test";
import { runActionFlow } from "../src/app/flow.ts";
import { REVIEW_SCOPE_DECISIONS, REVIEW_SCOPE_REASON_CODES } from "../src/app/pr-data.ts";
import type { ActionConfig, ReviewConfig, ReviewContext, ChangedFile, PullRequestInfo, ExistingComment } from "../src/types.ts";

const config: ReviewConfig = {
  provider: "google",
  apiKey: "test",
  modelId: "model",
  maxFiles: 1,
  ignorePatterns: [],
  repoRoot: process.cwd(),
  debug: false,
  reasoning: "off",
};

const actionConfig: ActionConfig = {
  review: config,
  reviewRun: [],
  commands: [],
  toolsAllowlist: [],
  outputCommentType: "both",
};

const context: ReviewContext = {
  owner: "owner",
  repo: "repo",
  prNumber: 1,
};

const prInfo: PullRequestInfo = {
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

const files: ChangedFile[] = [
  { filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, changes: 2 },
  { filename: "src/b.ts", status: "modified", additions: 1, deletions: 1, changes: 2 },
];

test("runActionFlow posts skip summary when file count exceeds max", async () => {
  let skipCalled = false;
  await runActionFlow({
    config: actionConfig,
    context,
    octokit: {} as any,
    fetchPrDataFn: async () => ({ prInfo, changedFiles: files }),
    fetchExistingCommentsFn: async () => ({ existingComments: [], reviewThreads: [] }),
    postSkipSummaryFn: async (_octokit, _context, _modelId, fileCount, maxFiles) => {
      skipCalled = true;
      expect(fileCount).toBe(2);
      expect(maxFiles).toBe(1);
    },
    runReviewFn: async () => {
      throw new Error("runReview should not be called");
    },
  });

  expect(skipCalled).toBe(true);
});

test("runActionFlow passes scope warning and previous summary into runReview", async () => {
  const comments: ExistingComment[] = [
    {
      id: 1,
      author: "bot",
      body: "## Review Summary\n\n**Verdict:** Approve\n\n<!-- sri:last-reviewed-sha:abcdef1 -->",
      url: "https://example.com/comment/1",
      type: "issue",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ];
  const scopedFiles: ChangedFile[] = [
    { filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, changes: 2 },
  ];

  let captured: any = null;
  await runActionFlow({
    config: {
      ...actionConfig,
      review: { ...config, maxFiles: 5 },
    },
    context,
    octokit: {} as any,
    fetchPrDataFn: async () => ({ prInfo, changedFiles: files }),
    fetchExistingCommentsFn: async () => ({ existingComments: comments, reviewThreads: [] }),
    fetchChangesSinceReviewFn: async () => ({
      files: scopedFiles,
      warning: "Scoped warning",
      decision: REVIEW_SCOPE_DECISIONS.REVIEW,
      reasonCode: REVIEW_SCOPE_REASON_CODES.SCOPED_REVIEW,
      reason: "Scoped review",
    }),
    runReviewFn: async (input) => {
      captured = input;
    },
  });

  expect(captured).not.toBeNull();
  expect(captured.lastReviewedSha).toBe("abcdef1");
  expect(captured.scopeWarning).toBe("Scoped warning");
  expect(captured.previousVerdict).toBe("Approve");
  expect(captured.changedFiles).toEqual(scopedFiles);
  expect(captured.fullPrChangedFiles).toEqual(files);
});

test("runActionFlow posts no-new-changes summary and skips review when scope says skip", async () => {
  const comments: ExistingComment[] = [
    {
      id: 1,
      author: "bot",
      body: "## Review Summary\n\n**Verdict:** Approve\n\n<!-- sri:last-reviewed-sha:abcdef1 -->",
      url: "https://example.com/comment/1",
      type: "issue",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ];
  let summaryCalled = false;
  await runActionFlow({
    config: {
      ...actionConfig,
      review: { ...config, maxFiles: 5 },
    },
    context,
    octokit: {} as any,
    fetchPrDataFn: async () => ({ prInfo, changedFiles: files }),
    fetchExistingCommentsFn: async () => ({ existingComments: comments, reviewThreads: [] }),
    fetchChangesSinceReviewFn: async () => ({
      files: [],
      warning: "History diverged",
      decision: REVIEW_SCOPE_DECISIONS.SKIP_CONFIDENT,
      reasonCode: REVIEW_SCOPE_REASON_CODES.LOCAL_TWO_DOT_NO_PR_FILE_CHANGES_SKIP,
      reason: "Push appears to be rebase/merge-only.",
    }),
    postNoNewChangesSummaryFn: async (_octokit, _context, _modelId, reviewSha, reason) => {
      summaryCalled = true;
      expect(reviewSha).toBe("head");
      expect(reason).toContain("rebase/merge-only");
    },
    runReviewFn: async () => {
      throw new Error("runReview should not be called");
    },
  });

  expect(summaryCalled).toBe(true);
});

test("runActionFlow logs scope shadow telemetry for review decisions", async () => {
  const comments: ExistingComment[] = [
    {
      id: 1,
      author: "bot",
      body: "## Review Summary\n\n**Verdict:** Approve\n\n<!-- sri:last-reviewed-sha:abcdef1 -->",
      url: "https://example.com/comment/1",
      type: "issue",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ];
  const logs: string[] = [];
  await runActionFlow({
    config: {
      ...actionConfig,
      review: { ...config, maxFiles: 5 },
    },
    context,
    octokit: {} as any,
    fetchPrDataFn: async () => ({ prInfo, changedFiles: files }),
    fetchExistingCommentsFn: async () => ({ existingComments: comments, reviewThreads: [] }),
    fetchChangesSinceReviewFn: async () => ({
      files: [files[0]],
      warning: null,
      decision: REVIEW_SCOPE_DECISIONS.REVIEW,
      reasonCode: REVIEW_SCOPE_REASON_CODES.SCOPED_REVIEW,
      reason: "Scoped review",
    }),
    runReviewFn: async () => {},
    logInfo: (message) => logs.push(message),
  });

  const line = logs.find((entry) => entry.includes("[scope-shadow]"));
  expect(line).toBeTruthy();
  expect(line).toContain("mode=review");
  expect(line).toContain("decision=review");
  expect(line).toContain("always_review_files_after_ignore=2");
  expect(line).toContain("file_delta_vs_always_review=1");
});

test("runActionFlow logs scope shadow telemetry for skip decisions", async () => {
  const comments: ExistingComment[] = [
    {
      id: 1,
      author: "bot",
      body: "## Review Summary\n\n**Verdict:** Approve\n\n<!-- sri:last-reviewed-sha:abcdef1 -->",
      url: "https://example.com/comment/1",
      type: "issue",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ];
  const logs: string[] = [];
  await runActionFlow({
    config: {
      ...actionConfig,
      review: { ...config, maxFiles: 5 },
    },
    context,
    octokit: {} as any,
    fetchPrDataFn: async () => ({ prInfo, changedFiles: files }),
    fetchExistingCommentsFn: async () => ({ existingComments: comments, reviewThreads: [] }),
    fetchChangesSinceReviewFn: async () => ({
      files: [],
      warning: null,
      decision: REVIEW_SCOPE_DECISIONS.SKIP_CONFIDENT,
      reasonCode: REVIEW_SCOPE_REASON_CODES.LOCAL_TWO_DOT_NO_PR_FILE_CHANGES_SKIP,
      reason: "No changes",
    }),
    postNoNewChangesSummaryFn: async () => {},
    runReviewFn: async () => {
      throw new Error("runReview should not be called");
    },
    logInfo: (message) => logs.push(message),
  });

  const line = logs.find((entry) => entry.includes("[scope-shadow]"));
  expect(line).toBeTruthy();
  expect(line).toContain("mode=skip");
  expect(line).toContain("decision=skip_confident");
  expect(line).toContain("always_review_files_after_ignore=2");
  expect(line).toContain("file_delta_vs_always_review=2");
});
