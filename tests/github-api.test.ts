import { test, expect } from "bun:test";
import { normalizeReviewThreadsGraphQL } from "../src/github-api.ts";

const thread = {
  id: "T1",
  isResolved: true,
  isOutdated: false,
  path: "src/index.ts",
  line: 10,
  side: "RIGHT" as const,
  comments: {
    nodes: [
      {
        databaseId: 101,
        author: { login: "alice" },
        body: "Root",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        url: "https://example.com/101",
      },
      {
        databaseId: 102,
        author: { login: "bob" },
        body: "Reply",
        createdAt: "2026-01-02T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
        url: "https://example.com/102",
      },
    ],
  },
};

test("normalizeReviewThreadsGraphQL maps resolved state and root comment", () => {
  const result = normalizeReviewThreadsGraphQL([thread]);
  expect(result.length).toBe(1);
  expect(result[0].rootCommentId).toBe(101);
  expect(result[0].lastActor).toBe("bob");
  expect(result[0].resolved).toBe(true);
  expect(result[0].isOutdated).toBe(false);
});
