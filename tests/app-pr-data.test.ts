import { test, expect } from "bun:test";
import { fetchChangesSinceReview, fetchExistingComments } from "../src/app/pr-data.ts";
import type { ReviewContext, ChangedFile } from "../src/types.ts";

const context: ReviewContext = {
  owner: "owner",
  repo: "repo",
  prNumber: 1,
};

test("fetchExistingComments falls back to threads from review comments on 404", async () => {
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
    request: async () => {
      const error: any = new Error("Not Found");
      error.status = 404;
      error.response = { status: 404, headers: {} };
      throw error;
    },
  };

  const { existingComments, reviewThreads } = await fetchExistingComments(octokit as any, context);

  expect(existingComments.length).toBe(3);
  expect(reviewThreads.length).toBe(1);
  expect(reviewThreads[0].rootCommentId).toBe(10);
  expect(reviewThreads[0].lastActor).toBe("carol");
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
});
