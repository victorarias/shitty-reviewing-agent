import { test, expect } from "bun:test";
import {
  fetchChangesSinceReview,
  fetchExistingComments,
  REVIEW_SCOPE_DECISIONS,
  REVIEW_SCOPE_REASON_CODES,
} from "../src/app/pr-data.ts";
import type { ReviewContext, ChangedFile } from "../src/types.ts";

const context: ReviewContext = {
  owner: "owner",
  repo: "repo",
  prNumber: 1,
};

test("fetchChangesSinceReview skips when last reviewed SHA matches current head", async () => {
  const result = await fetchChangesSinceReview(
    {} as any,
    context,
    "same-sha",
    "same-sha",
    []
  );

  expect(result.files).toEqual([]);
  expect(result.warning).toBeNull();
  expect(result.decision).toBe(REVIEW_SCOPE_DECISIONS.SKIP_CONFIDENT);
  expect(result.reasonCode).toBe(REVIEW_SCOPE_REASON_CODES.BASE_EQUALS_HEAD_SKIP);
});

test("fetchExistingComments throws on GraphQL failure", async () => {
  const issueComments = [
    {
      id: 1,
      user: { login: "alice" },
      body: "Issue comment",
      html_url: "https://example.com/issue/1",
      updated_at: "2026-01-01T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z",
    },
  ];
  const reviewComments = [
    {
      id: 10,
      user: { login: "bob" },
      body: "Root",
      html_url: "https://example.com/review/10",
      path: "src/index.ts",
      line: 5,
      side: "RIGHT",
      updated_at: "2026-01-02T00:00:00Z",
      created_at: "2026-01-02T00:00:00Z",
    },
    {
      id: 11,
      user: { login: "carol" },
      body: "Reply",
      html_url: "https://example.com/review/11",
      path: "src/index.ts",
      line: 5,
      side: "RIGHT",
      in_reply_to_id: 10,
      updated_at: "2026-01-03T00:00:00Z",
      created_at: "2026-01-03T00:00:00Z",
    },
  ];

  const octokit = {
    rest: {
      issues: { listComments: () => ({}) },
      pulls: { listReviewComments: () => ({}) },
    },
    paginate: async (fn: any) => {
      if (fn === octokit.rest.issues.listComments) return issueComments;
      if (fn === octokit.rest.pulls.listReviewComments) return reviewComments;
      return [];
    },
    graphql: async () => {
      throw new Error("GraphQL error");
    },
  };

  let error: unknown = null;
  try {
    await fetchExistingComments(octokit as any, context);
  } catch (err) {
    error = err;
  }

  expect(error).toBeTruthy();
});

test("fetchChangesSinceReview returns warning on 404 compare", async () => {
  const fallbackFiles: ChangedFile[] = [
    { filename: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2 },
  ];
  const octokit = {
    rest: {
      repos: {
        compareCommits: async () => {
          const error: any = new Error("Not Found");
          error.status = 404;
          error.response = { status: 404 };
          throw error;
        },
      },
    },
  };

  const result = await fetchChangesSinceReview(
    octokit as any,
    context,
    "base",
    "head",
    fallbackFiles
  );

  expect(result.files).toEqual(fallbackFiles);
  expect(result.warning).toContain("Previous review SHA no longer exists");
  expect(result.decision).toBe(REVIEW_SCOPE_DECISIONS.REVIEW);
  expect(result.reasonCode).toBe(REVIEW_SCOPE_REASON_CODES.COMPARE_404_REVIEW_FULL_PR);
});

test("fetchChangesSinceReview falls back to full PR diff when compare has empty files", async () => {
  const fallbackFiles: ChangedFile[] = [
    { filename: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2 },
  ];
  const octokit = {
    rest: {
      repos: {
        compareCommits: async () => ({
          data: {
            status: "ahead",
            ahead_by: 1,
            behind_by: 0,
            files: [],
          },
        }),
      },
    },
  };

  const result = await fetchChangesSinceReview(
    octokit as any,
    context,
    "base",
    "head",
    fallbackFiles
  );

  expect(result.files).toEqual(fallbackFiles);
  expect(result.decision).toBe(REVIEW_SCOPE_DECISIONS.REVIEW);
  expect(result.reasonCode).toBe(REVIEW_SCOPE_REASON_CODES.COMPARE_EMPTY_REVIEW_FULL_PR);
});

test("fetchChangesSinceReview only returns files still present in current PR diff", async () => {
  const fallbackFiles: ChangedFile[] = [
    { filename: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch: "@@ -1 +1 @@" },
  ];
  const octokit = {
    rest: {
      repos: {
        compareCommits: async () => ({
          data: {
            status: "ahead",
            behind_by: 0,
            files: [
              {
                filename: "src/index.ts",
                status: "modified",
                additions: 10,
                deletions: 10,
                changes: 20,
                patch: "compare patch that should not be used",
              },
              {
                filename: "src/from-main.ts",
                status: "modified",
                additions: 5,
                deletions: 0,
                changes: 5,
              },
            ],
          },
        }),
      },
    },
  };

  const result = await fetchChangesSinceReview(
    octokit as any,
    context,
    "base",
    "head",
    fallbackFiles
  );

  expect(result.warning).toBeNull();
  expect(result.files).toEqual(fallbackFiles);
  expect(result.decision).toBe(REVIEW_SCOPE_DECISIONS.REVIEW);
  expect(result.reasonCode).toBe(REVIEW_SCOPE_REASON_CODES.SCOPED_REVIEW);
});

test("fetchChangesSinceReview warns and scopes to PR diff when history diverged", async () => {
  const fallbackFiles: ChangedFile[] = [
    { filename: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2 },
    { filename: "src/other.ts", status: "modified", additions: 1, deletions: 1, changes: 2 },
  ];
  const octokit = {
    rest: {
      repos: {
        compareCommits: async () => ({
          data: {
            status: "diverged",
            behind_by: 1,
            files: [
              {
                filename: "src/index.ts",
                status: "modified",
                additions: 1,
                deletions: 1,
                changes: 2,
              },
              {
                filename: "src/from-main.ts",
                status: "modified",
                additions: 3,
                deletions: 0,
                changes: 3,
              },
            ],
          },
        }),
      },
    },
  };

  const result = await fetchChangesSinceReview(
    octokit as any,
    context,
    "base",
    "head",
    fallbackFiles
  );

  expect(result.decision).toBe(REVIEW_SCOPE_DECISIONS.REVIEW);
  expect(result.files).toEqual([fallbackFiles[0]]);
  expect(result.warning).toContain("Scoped to current PR diff");
  expect(result.reasonCode).toBe(REVIEW_SCOPE_REASON_CODES.DIVERGED_SCOPED_REVIEW);
});

test("fetchChangesSinceReview stays on review path for diverged updates without local verification", async () => {
  const fallbackFiles: ChangedFile[] = [
    { filename: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2 },
  ];
  const octokit = {
    rest: {
      repos: {
        compareCommits: async () => ({
          data: {
            status: "diverged",
            ahead_by: 4,
            behind_by: 1,
            files: [
              {
                filename: "src/index.ts",
                status: "modified",
                additions: 1,
                deletions: 1,
                changes: 2,
              },
              {
                filename: "src/from-main.ts",
                status: "modified",
                additions: 3,
                deletions: 0,
                changes: 3,
              },
            ],
          },
        }),
      },
    },
  };

  const result = await fetchChangesSinceReview(
    octokit as any,
    context,
    "base",
    "head",
    fallbackFiles
  );

  expect(result.files).toEqual(fallbackFiles);
  expect(result.decision).toBe(REVIEW_SCOPE_DECISIONS.REVIEW);
  expect(result.reasonCode).toBe(REVIEW_SCOPE_REASON_CODES.DIVERGED_SCOPED_REVIEW);
  expect(result.warning).toContain("Scoped to current PR diff");
});
