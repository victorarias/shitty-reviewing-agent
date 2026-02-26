import { test, expect } from "bun:test";
import { createGithubTools } from "../src/tools/github.ts";

test("get_review_context includes standalone issue comment replies to bot summaries", async () => {
  const listComments = async (_args: any) => ({ data: [] });
  const listCommits = async (_args: any) => ({ data: [] });
  const listFiles = async (_args: any) => ({ data: [] });

  const issueComments = [
    {
      id: 1,
      user: { login: "dev-a", type: "User" },
      author_association: "MEMBER",
      body: "Drive-by note before any bot review",
      created_at: "2026-02-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z",
      html_url: "https://example.com/c1",
    },
    {
      id: 2,
      user: { login: "github-actions", type: "Bot" },
      author_association: "NONE",
      body: "## Review Summary\n\n---\n*Reviewed by shitty-reviewing-agent • model: m*\n<!-- sri:bot-comment -->",
      created_at: "2026-02-02T00:00:00Z",
      updated_at: "2026-02-02T00:00:00Z",
      html_url: "https://example.com/c2",
    },
    {
      id: 3,
      user: { login: "dev-a", type: "User" },
      author_association: "MEMBER",
      body: "I disagree with this finding because of migration behavior.",
      created_at: "2026-02-02T00:10:00Z",
      updated_at: "2026-02-02T00:10:00Z",
      html_url: "https://example.com/c3",
    },
    {
      id: 4,
      user: { login: "github-actions", type: "Bot" },
      author_association: "NONE",
      body: "Coverage bot payload (not reviewer bot).",
      created_at: "2026-02-02T00:20:00Z",
      updated_at: "2026-02-02T00:20:00Z",
      html_url: "https://example.com/c4",
    },
    {
      id: 5,
      user: { login: "dev-b", type: "User" },
      author_association: "MEMBER",
      body: "Additional rationale outside a thread.",
      created_at: "2026-02-02T00:30:00Z",
      updated_at: "2026-02-02T00:30:00Z",
      html_url: "https://example.com/c5",
    },
    {
      id: 6,
      user: { login: "github-actions", type: "Bot" },
      author_association: "NONE",
      body: "## Review Summary\n\n---\n*Reviewed by shitty-reviewing-agent • model: m*\n<!-- sri:bot-comment -->",
      created_at: "2026-02-03T00:00:00Z",
      updated_at: "2026-02-03T00:00:00Z",
      html_url: "https://example.com/c6",
    },
    {
      id: 7,
      user: { login: "dev-a", type: "User" },
      author_association: "MEMBER",
      body: "Latest author response after the most recent summary.",
      created_at: "2026-02-03T00:10:00Z",
      updated_at: "2026-02-03T00:10:00Z",
      html_url: "https://example.com/c7",
    },
  ];

  const commits = [
    {
      sha: "aaa",
      commit: { message: "old", author: { date: "2026-02-01T00:00:00Z" }, committer: { date: "2026-02-01T00:00:00Z" } },
      author: { login: "dev-a" },
      html_url: "https://example.com/commit/aaa",
    },
    {
      sha: "bbb",
      commit: { message: "new", author: { date: "2026-02-03T00:20:00Z" }, committer: { date: "2026-02-03T00:20:00Z" } },
      author: { login: "dev-a" },
      html_url: "https://example.com/commit/bbb",
    },
  ];

  const octokit = {
    rest: {
      issues: {
        listComments,
      },
      pulls: {
        listCommits,
        listFiles,
      },
    },
    paginate: async (method: any, _args: any) => {
      if (method === listComments) return issueComments;
      if (method === listCommits) return commits;
      if (method === listFiles) return [];
      return [];
    },
    graphql: async () => ({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    }),
  };

  const tools = createGithubTools({
    octokit: octokit as any,
    owner: "o",
    repo: "r",
    pullNumber: 1,
    cache: {},
  });

  const getReviewContext = tools.find((tool) => tool.name === "get_review_context");
  if (!getReviewContext) throw new Error("Missing get_review_context tool");

  const result = await getReviewContext.execute("", {});
  const details = result.details as any;

  expect(details.lastReviewAt).toBe("2026-02-03T00:00:00Z");
  expect(details.reviewThreads).toHaveLength(0);
  expect(details.issueCommentReplies.map((item: any) => item.id)).toEqual([7, 5, 3]);

  expect(details.issueCommentReplies[0].replyToBotCommentId).toBe(6);
  expect(details.issueCommentReplies[0].replyToBotSummary).toBe(true);
  expect(details.issueCommentReplies[0].hasNewActivitySinceLastReview).toBe(true);

  expect(details.issueCommentReplies[1].replyToBotCommentId).toBe(2);
  expect(details.issueCommentReplies[1].hasNewActivitySinceLastReview).toBe(false);

  expect(details.issueCommentReplies[2].replyToBotCommentId).toBe(2);
  expect(details.issueCommentReplies[2].hasNewActivitySinceLastReview).toBe(false);

  expect(details.commitsSinceLastReview.map((item: any) => item.sha)).toEqual(["bbb"]);
});
