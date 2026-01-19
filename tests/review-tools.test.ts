import { test, expect } from "bun:test";
import { createReviewTools } from "../src/tools/review.ts";
import type { ExistingComment } from "../src/types.ts";

function makeOctokitSpy() {
  const calls: Array<{ type: string; args: any }> = [];
  const octokit = {
    rest: {
      pulls: {
        createReplyForReviewComment: async (args: any) => {
          calls.push({ type: "reply", args });
          return { data: { id: 101 } };
        },
        createReviewComment: async (args: any) => {
          calls.push({ type: "comment", args });
          return { data: { id: 202 } };
        },
      },
      issues: {
        createComment: async () => ({ data: { id: 303 } }),
      },
    },
  };
  return { octokit, calls };
}

function getTool(tools: ReturnType<typeof createReviewTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

test("comment tool replies to latest active thread root", async () => {
  const existingComments: ExistingComment[] = [
    {
      id: 1,
      author: "alice",
      body: "Original comment",
      url: "https://example.com/1",
      type: "review",
      path: "src/index.ts",
      line: 10,
      updatedAt: "2026-01-01T00:00:00Z",
    },
    {
      id: 2,
      author: "bob",
      body: "Reply",
      url: "https://example.com/2",
      type: "review",
      path: "src/index.ts",
      line: 10,
      inReplyToId: 1,
      updatedAt: "2026-01-03T00:00:00Z",
    },
  ];

  const { octokit, calls } = makeOctokitSpy();
  const tools = createReviewTools({
    octokit: octokit as any,
    owner: "o",
    repo: "r",
    pullNumber: 1,
    headSha: "sha",
    modelId: "model",
    reviewSha: "sha",
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments,
  });

  const commentTool = getTool(tools, "comment");
  await commentTool.execute("", {
    path: "src/index.ts",
    line: 10,
    body: "New feedback",
  });

  expect(calls.length).toBe(1);
  expect(calls[0].type).toBe("reply");
  expect(calls[0].args.comment_id).toBe(1);
});

test("comment tool falls back to new comment when no thread", async () => {
  const existingComments: ExistingComment[] = [];
  const { octokit, calls } = makeOctokitSpy();
  const tools = createReviewTools({
    octokit: octokit as any,
    owner: "o",
    repo: "r",
    pullNumber: 1,
    headSha: "sha",
    modelId: "model",
    reviewSha: "sha",
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments,
  });

  const commentTool = getTool(tools, "comment");
  await commentTool.execute("", {
    path: "src/index.ts",
    line: 10,
    body: "New feedback",
  });

  expect(calls.length).toBe(1);
  expect(calls[0].type).toBe("comment");
});

test("comment tool prefers thread with most recent activity", async () => {
  const existingComments: ExistingComment[] = [
    {
      id: 10,
      author: "alice",
      body: "Root A",
      url: "https://example.com/10",
      type: "review",
      path: "src/index.ts",
      line: 20,
      updatedAt: "2026-01-01T00:00:00Z",
    },
    {
      id: 11,
      author: "bob",
      body: "Root B",
      url: "https://example.com/11",
      type: "review",
      path: "src/index.ts",
      line: 20,
      updatedAt: "2026-01-02T00:00:00Z",
    },
    {
      id: 12,
      author: "carol",
      body: "Reply on A",
      url: "https://example.com/12",
      type: "review",
      path: "src/index.ts",
      line: 20,
      inReplyToId: 10,
      updatedAt: "2026-01-05T00:00:00Z",
    },
  ];

  const { octokit, calls } = makeOctokitSpy();
  const tools = createReviewTools({
    octokit: octokit as any,
    owner: "o",
    repo: "r",
    pullNumber: 1,
    headSha: "sha",
    modelId: "model",
    reviewSha: "sha",
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments,
  });

  const commentTool = getTool(tools, "comment");
  await commentTool.execute("", {
    path: "src/index.ts",
    line: 20,
    body: "Follow-up",
  });

  expect(calls.length).toBe(1);
  expect(calls[0].type).toBe("reply");
  expect(calls[0].args.comment_id).toBe(10);
});
