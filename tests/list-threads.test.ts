import { test, expect } from "bun:test";
import { createReviewTools } from "../src/tools/review.ts";
import type { ReviewThreadInfo } from "../src/types.ts";

function makeOctokitStub() {
  return {
    rest: {
      pulls: {
        createReplyForReviewComment: async () => ({ data: { id: 1 } }),
        createReviewComment: async () => ({ data: { id: 2 } }),
      },
      issues: {
        createComment: async () => ({ data: { id: 3 } }),
      },
    },
  };
}

function getTool(tools: ReturnType<typeof createReviewTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

test("list_threads_for_location filters by side", async () => {
  const reviewThreads: ReviewThreadInfo[] = [
    {
      id: 1,
      path: "src/index.ts",
      line: 10,
      side: "RIGHT",
      isOutdated: false,
      resolved: false,
      lastUpdatedAt: "2026-01-06T00:00:00Z",
      lastActor: "dev",
      rootCommentId: 11,
      url: "https://example.com/thread/1",
    },
    {
      id: 2,
      path: "src/index.ts",
      line: 10,
      side: "LEFT",
      isOutdated: false,
      resolved: false,
      lastUpdatedAt: "2026-01-05T00:00:00Z",
      lastActor: "dev",
      rootCommentId: 12,
      url: "https://example.com/thread/2",
    },
  ];

  const tools = createReviewTools({
    octokit: makeOctokitStub() as any,
    owner: "o",
    repo: "r",
    pullNumber: 1,
    headSha: "sha",
    modelId: "model",
    reviewSha: "sha",
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments: [],
    reviewThreads,
  });

  const listTool = getTool(tools, "list_threads_for_location");
  const result = await listTool.execute("", {
    path: "src/index.ts",
    line: 10,
    side: "RIGHT",
  });

  expect(result.details.threads.length).toBe(1);
  expect(result.details.threads[0].id).toBe(1);
});
