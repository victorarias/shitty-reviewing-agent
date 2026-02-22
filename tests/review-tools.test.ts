import { test, expect } from "bun:test";
import { createReviewTools } from "../src/tools/review.ts";
import type { ExistingComment } from "../src/types.ts";

function makeOctokitSpy() {
  const calls: Array<{ type: string; args: any }> = [];
  const octokit = {
    rest: {
      pulls: {
        updateReviewComment: async (args: any) => {
          calls.push({ type: "update", args });
          return { data: { id: args.comment_id } };
        },
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
        updateComment: async (args: any) => {
          calls.push({ type: "issue_update", args });
          return { data: { id: args.comment_id } };
        },
      },
    },
    graphql: async (query: string, args: any) => {
      calls.push({ type: "graphql", args: { query, ...args } });
      return { resolveReviewThread: { thread: { id: args.threadId, isResolved: true } } };
    },
  };
  return { octokit, calls };
}

function getTool(tools: ReturnType<typeof createReviewTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

const patch = `@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n`;

test("comment tool replies to latest active thread root", async () => {
  const existingComments: ExistingComment[] = [
    {
      id: 1,
      author: "alice",
      body: "Original comment",
      url: "https://example.com/1",
      type: "review",
      path: "src/index.ts",
      line: 1,
      updatedAt: "2026-01-01T00:00:00Z",
    },
    {
      id: 2,
      author: "bob",
      body: "Reply",
      url: "https://example.com/2",
      type: "review",
      path: "src/index.ts",
      line: 1,
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
    changedFiles: [{ filename: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch }],
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments,
    reviewThreads: [
      {
        id: 99,
        path: "src/index.ts",
        line: 1,
        side: "RIGHT",
        isOutdated: false,
        resolved: false,
        lastUpdatedAt: "2026-01-03T00:00:00Z",
        lastActor: "bob",
        rootCommentId: 1,
        url: "https://example.com/thread/99",
      },
    ],
  });

  const commentTool = getTool(tools, "comment");
  await commentTool.execute("", {
    path: "src/index.ts",
    line: 1,
    side: "RIGHT",
    body: "New feedback",
  });

  expect(calls.length).toBe(1);
  expect(calls[0].type).toBe("reply");
  expect(calls[0].args.comment_id).toBe(1);
});

test("comment tool asks to update when latest thread actor is a bot", async () => {
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
    changedFiles: [{ filename: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch }],
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments,
    reviewThreads: [
      {
        id: 77,
        path: "src/index.ts",
        line: 1,
        side: "RIGHT",
        isOutdated: false,
        resolved: false,
        lastUpdatedAt: "2026-01-03T00:00:00Z",
        lastActor: "github-actions[bot]",
        rootCommentId: 5,
        url: "https://example.com/thread/77",
      },
    ],
  });

  const commentTool = getTool(tools, "comment");
  const result = await commentTool.execute("", {
    path: "src/index.ts",
    line: 1,
    side: "RIGHT",
    body: "Repeat feedback",
  });

  expect(calls.length).toBe(0);
  expect(result.details.id).toBe(-1);
  expect(result.content[0].text).toContain("update_comment");
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
    changedFiles: [{ filename: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch }],
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments,
    reviewThreads: [],
  });

  const commentTool = getTool(tools, "comment");
  await commentTool.execute("", {
    path: "src/index.ts",
    line: 1,
    side: "RIGHT",
    body: "New feedback",
  });

  expect(calls.length).toBe(1);
  expect(calls[0].type).toBe("comment");
});

test("comment tool appends bot marker to new comments", async () => {
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
    changedFiles: [{ filename: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch }],
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments,
    reviewThreads: [],
  });

  const commentTool = getTool(tools, "comment");
  await commentTool.execute("", {
    path: "src/index.ts",
    line: 1,
    side: "RIGHT",
    body: "New feedback",
  });

  expect(calls.length).toBe(1);
  expect(calls[0].args.body).toContain("<!-- sri:bot-comment -->");
});

test("resolve_thread replies with explanation and resolves bot thread", async () => {
  const existingComments: ExistingComment[] = [
    {
      id: 5,
      author: "github-actions[bot]",
      body: "Original issue\n\n<!-- sri:bot-comment -->",
      url: "https://example.com/5",
      type: "review",
      path: "src/index.ts",
      line: 1,
      side: "RIGHT",
      updatedAt: "2026-01-01T00:00:00Z",
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
    changedFiles: [{ filename: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch }],
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments,
    reviewThreads: [
      {
        id: 5,
        threadId: "T123",
        path: "src/index.ts",
        line: 1,
        side: "RIGHT",
        isOutdated: false,
        resolved: false,
        lastUpdatedAt: "2026-01-02T00:00:00Z",
        lastActor: "github-actions[bot]",
        rootCommentId: 5,
        url: "https://example.com/thread/5",
      },
    ],
  });

  const resolveTool = getTool(tools, "resolve_thread");
  await resolveTool.execute("", {
    thread_id: 5,
    body: "Fixed by validating input upstream.",
  });

  expect(calls.find((call) => call.type === "reply")?.args.body).toContain("<!-- sri:bot-comment -->");
  expect(calls.find((call) => call.type === "graphql")?.args.threadId).toBe("T123");
});

test("resolve_thread resolves even when thread has no line", async () => {
  const existingComments: ExistingComment[] = [
    {
      id: 5,
      author: "github-actions[bot]",
      body: "Original issue\n\n<!-- sri:bot-comment -->",
      url: "https://example.com/5",
      type: "review",
      path: "src/index.ts",
      line: 1,
      side: "RIGHT",
      updatedAt: "2026-01-01T00:00:00Z",
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
    changedFiles: [{ filename: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch }],
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments,
    reviewThreads: [
      {
        id: 5,
        threadId: "T123",
        path: "src/index.ts",
        line: null,
        side: "RIGHT",
        isOutdated: false,
        resolved: false,
        lastUpdatedAt: "2026-01-02T00:00:00Z",
        lastActor: "github-actions[bot]",
        rootCommentId: 5,
        url: "https://example.com/thread/5",
      },
    ],
  });

  const resolveTool = getTool(tools, "resolve_thread");
  await resolveTool.execute("", {
    thread_id: 5,
    body: "Fixed by validating input upstream.",
  });

  expect(calls.find((call) => call.type === "reply")).toBeTruthy();
  expect(calls.find((call) => call.type === "graphql")?.args.threadId).toBe("T123");
});

test("resolve_thread handles integration permission errors gracefully", async () => {
  const existingComments: ExistingComment[] = [
    {
      id: 9,
      author: "github-actions[bot]",
      body: "Original issue\n\n<!-- sri:bot-comment -->",
      url: "https://example.com/9",
      type: "review",
      path: "src/index.ts",
      line: 1,
      side: "RIGHT",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ];
  const calls: Array<{ type: string; args: any }> = [];
  const octokit = {
    rest: {
      pulls: {
        createReplyForReviewComment: async (args: any) => {
          calls.push({ type: "reply", args });
          return { data: { id: 101 } };
        },
      },
    },
    graphql: async () => {
      throw new Error("Resource not accessible by integration");
    },
  };
  const tools = createReviewTools({
    octokit: octokit as any,
    owner: "o",
    repo: "r",
    pullNumber: 1,
    headSha: "sha",
    modelId: "model",
    reviewSha: "sha",
    changedFiles: [{ filename: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch }],
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments,
    reviewThreads: [
      {
        id: 9,
        threadId: "T999",
        path: "src/index.ts",
        line: 1,
        side: "RIGHT",
        isOutdated: false,
        resolved: false,
        lastUpdatedAt: "2026-01-02T00:00:00Z",
        lastActor: "github-actions[bot]",
        rootCommentId: 9,
        url: "https://example.com/thread/9",
      },
    ],
  });

  const resolveTool = getTool(tools, "resolve_thread");
  const result = await resolveTool.execute("", {
    thread_id: 9,
    body: "Fixed by validating input upstream.",
  });

  expect(calls.find((call) => call.type === "reply")).toBeTruthy();
  expect(result.content[0].text).toContain("Unable to resolve thread");
});

test("comment tool prefers most recent activity when no threads exist", async () => {
  const existingComments: ExistingComment[] = [
    {
      id: 10,
      author: "alice",
      body: "Root A",
      url: "https://example.com/10",
      type: "review",
      path: "src/index.ts",
      line: 1,
      side: "RIGHT",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    {
      id: 11,
      author: "bob",
      body: "Root B",
      url: "https://example.com/11",
      type: "review",
      path: "src/index.ts",
      line: 1,
      side: "RIGHT",
      updatedAt: "2026-01-02T00:00:00Z",
    },
    {
      id: 12,
      author: "carol",
      body: "Reply on A",
      url: "https://example.com/12",
      type: "review",
      path: "src/index.ts",
      line: 1,
      side: "RIGHT",
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
    changedFiles: [{ filename: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch }],
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments,
    reviewThreads: [],
  });

  const commentTool = getTool(tools, "comment");
  await commentTool.execute("", {
    path: "src/index.ts",
    line: 1,
    side: "RIGHT",
    body: "Follow-up",
  });

  expect(calls.length).toBe(1);
  expect(calls[0].type).toBe("reply");
  expect(calls[0].args.comment_id).toBe(10);
});

test("comment tool asks to update when latest activity is from a bot", async () => {
  const existingComments: ExistingComment[] = [
    {
      id: 20,
      author: "github-actions[bot]",
      authorType: "Bot",
      body: "Original comment",
      url: "https://example.com/20",
      type: "review",
      path: "src/index.ts",
      line: 1,
      side: "RIGHT",
      updatedAt: "2026-01-02T00:00:00Z",
    },
    {
      id: 21,
      author: "github-actions[bot]",
      authorType: "Bot",
      body: "Follow-up",
      url: "https://example.com/21",
      type: "review",
      path: "src/index.ts",
      line: 1,
      side: "RIGHT",
      inReplyToId: 20,
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
    changedFiles: [{ filename: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch }],
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments,
    reviewThreads: [],
  });

  const commentTool = getTool(tools, "comment");
  const result = await commentTool.execute("", {
    path: "src/index.ts",
    line: 1,
    side: "RIGHT",
    body: "Repeat feedback",
  });

  expect(calls.length).toBe(0);
  expect(result.details.id).toBe(-1);
  expect(result.content[0].text).toContain("update_comment");
});

test("comment tool replies when human quotes bot marker", async () => {
  const existingComments: ExistingComment[] = [
    {
      id: 30,
      author: "github-actions[bot]",
      authorType: "Bot",
      body: "Original comment\n\n<!-- sri:bot-comment -->",
      url: "https://example.com/30",
      type: "review",
      path: "src/index.ts",
      line: 1,
      side: "RIGHT",
      updatedAt: "2026-01-02T00:00:00Z",
    },
    {
      id: 31,
      author: "alice",
      authorType: "User",
      body: "> Original comment\n>\n> <!-- sri:bot-comment -->\n\nLooks good now.",
      url: "https://example.com/31",
      type: "review",
      path: "src/index.ts",
      line: 1,
      side: "RIGHT",
      inReplyToId: 30,
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
    changedFiles: [{ filename: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch }],
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments,
    reviewThreads: [],
  });

  const commentTool = getTool(tools, "comment");
  await commentTool.execute("", {
    path: "src/index.ts",
    line: 1,
    side: "RIGHT",
    body: "New feedback",
  });

  expect(calls.length).toBe(1);
  expect(calls[0].type).toBe("reply");
  expect(calls[0].args.comment_id).toBe(30);
});

test("comment tool errors when threads exist and no side/thread_id specified", async () => {
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
    changedFiles: [{ filename: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch }],
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments,
    reviewThreads: [
      {
        id: 12,
        path: "src/index.ts",
        line: 30,
        side: "LEFT",
        isOutdated: false,
        resolved: false,
        lastUpdatedAt: "2026-01-05T00:00:00Z",
        lastActor: "carol",
        rootCommentId: 120,
        url: "https://example.com/thread/12",
      },
      {
        id: 13,
        path: "src/index.ts",
        line: 30,
        side: "RIGHT",
        isOutdated: false,
        resolved: false,
        lastUpdatedAt: "2026-01-06T00:00:00Z",
        lastActor: "dave",
        rootCommentId: 130,
        url: "https://example.com/thread/13",
      },
    ],
  });

  const commentTool = getTool(tools, "comment");
  const result = await commentTool.execute("", {
    path: "src/index.ts",
    line: 30,
    body: "New feedback",
  });

  expect(calls.length).toBe(0);
  expect(result.details.id).toBe(-1);
  expect(result.content[0].text).toContain("Missing side");
});

test("comment tool can force new thread with allow_new_thread", async () => {
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
    changedFiles: [{ filename: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch }],
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments,
    reviewThreads: [
      {
        id: 14,
        path: "src/index.ts",
        line: 1,
        side: "RIGHT",
        isOutdated: false,
        resolved: false,
        lastUpdatedAt: "2026-01-06T00:00:00Z",
        lastActor: "dave",
        rootCommentId: 140,
        url: "https://example.com/thread/14",
      },
    ],
  });

  const commentTool = getTool(tools, "comment");
  await commentTool.execute("", {
    path: "src/index.ts",
    line: 1,
    side: "RIGHT",
    body: "Fresh thread",
    allow_new_thread: true,
  });

  expect(calls.length).toBe(1);
  expect(calls[0].type).toBe("comment");
});

test("update_comment tool updates existing review comment", async () => {
  const { octokit, calls } = makeOctokitSpy();
  const tools = createReviewTools({
    octokit: octokit as any,
    owner: "o",
    repo: "r",
    pullNumber: 1,
    headSha: "sha",
    modelId: "model",
    reviewSha: "sha",
    changedFiles: [],
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments: [],
    reviewThreads: [],
  });

  const updateTool = getTool(tools, "update_comment");
  await updateTool.execute("", {
    comment_id: 55,
    body: "Updated content",
  });

  expect(calls.length).toBe(1);
  expect(calls[0].type).toBe("update");
  expect(calls[0].args.comment_id).toBe(55);
});

test("update_comment tool updates issue comment", async () => {
  const existingComments: ExistingComment[] = [
    {
      id: 70,
      author: "alice",
      body: "Original summary",
      url: "https://example.com/70",
      type: "issue",
      updatedAt: "2026-01-01T00:00:00Z",
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
    changedFiles: [],
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments,
    reviewThreads: [],
  });

  const updateTool = getTool(tools, "update_comment");
  await updateTool.execute("", {
    comment_id: 70,
    body: "Updated summary",
  });

  expect(calls.length).toBe(1);
  expect(calls[0].type).toBe("issue_update");
  expect(calls[0].args.comment_id).toBe(70);
  expect(calls[0].args.body).toContain("<!-- sri:bot-comment -->");
});

test("update_comment updates review comment ids", async () => {
  const existingComments: ExistingComment[] = [
    {
      id: 80,
      author: "alice",
      body: "Original inline",
      url: "https://example.com/80",
      type: "review",
      path: "src/index.ts",
      line: 1,
      side: "RIGHT",
      updatedAt: "2026-01-01T00:00:00Z",
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
    changedFiles: [],
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments,
    reviewThreads: [],
  });

  const updateTool = getTool(tools, "update_comment");
  await updateTool.execute("", {
    comment_id: 80,
    body: "Updated summary",
  });

  expect(calls.length).toBe(1);
  expect(calls[0].type).toBe("update");
  expect(calls[0].args.comment_id).toBe(80);
});

test("update_comment rejects cross-type updates in issue-only mode", async () => {
  const existingComments: ExistingComment[] = [
    {
      id: 81,
      author: "alice",
      body: "Original inline",
      url: "https://example.com/81",
      type: "review",
      path: "src/index.ts",
      line: 1,
      side: "RIGHT",
      updatedAt: "2026-01-01T00:00:00Z",
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
    changedFiles: [],
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments,
    reviewThreads: [],
    commentType: "issue",
  });

  const updateTool = getTool(tools, "update_comment");
  const result = await updateTool.execute("", {
    comment_id: 81,
    body: "Updated summary",
  });

  expect(calls.length).toBe(0);
  expect(result.details.id).toBe(-1);
  expect(result.content[0].text).toContain("issue-only mode");
});

test("update_comment uses issue API directly in issue-only mode", async () => {
  const { octokit, calls } = makeOctokitSpy();
  const tools = createReviewTools({
    octokit: octokit as any,
    owner: "o",
    repo: "r",
    pullNumber: 1,
    headSha: "sha",
    modelId: "model",
    reviewSha: "sha",
    changedFiles: [],
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments: [],
    reviewThreads: [],
    commentType: "issue",
  });

  const updateTool = getTool(tools, "update_comment");
  await updateTool.execute("", {
    comment_id: 82,
    body: "Updated summary",
  });

  expect(calls.length).toBe(1);
  expect(calls[0].type).toBe("issue_update");
  expect(calls[0].args.comment_id).toBe(82);
});

test("update_comment falls back to issue comments when review update is wrong type", async () => {
  const { octokit, calls } = makeOctokitSpy();
  octokit.rest.pulls.updateReviewComment = async (args: any) => {
    calls.push({ type: "update_fail", args });
    const error: any = new Error("Not Found");
    error.status = 404;
    throw error;
  };
  const tools = createReviewTools({
    octokit: octokit as any,
    owner: "o",
    repo: "r",
    pullNumber: 1,
    headSha: "sha",
    modelId: "model",
    reviewSha: "sha",
    changedFiles: [],
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments: [],
    reviewThreads: [],
  });

  const updateTool = getTool(tools, "update_comment");
  await updateTool.execute("", {
    comment_id: 99,
    body: "Updated summary",
  });

  expect(calls.length).toBe(2);
  expect(calls[0].type).toBe("update_fail");
  expect(calls[1].type).toBe("issue_update");
  expect(calls[1].args.comment_id).toBe(99);
  expect(calls[1].args.body).toContain("<!-- sri:bot-comment -->");
});

test("comment tool rejects lines not in diff", async () => {
  const { octokit, calls } = makeOctokitSpy();
  const tools = createReviewTools({
    octokit: octokit as any,
    owner: "o",
    repo: "r",
    pullNumber: 1,
    headSha: "sha",
    modelId: "model",
    reviewSha: "sha",
    changedFiles: [{ filename: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch }],
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments: [],
    reviewThreads: [],
  });

  const commentTool = getTool(tools, "comment");
  const result = await commentTool.execute("", {
    path: "src/index.ts",
    line: 99,
    side: "RIGHT",
    body: "Out of diff",
  });

  expect(calls.length).toBe(0);
  expect(result.details.id).toBe(-1);
  expect(result.content[0].text).toContain("not present");
});

test("comment tool accepts valid diff lines on LEFT/RIGHT", async () => {
  const { octokit, calls } = makeOctokitSpy();
  const tools = createReviewTools({
    octokit: octokit as any,
    owner: "o",
    repo: "r",
    pullNumber: 1,
    headSha: "sha",
    modelId: "model",
    reviewSha: "sha",
    changedFiles: [{ filename: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch }],
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments: [],
    reviewThreads: [],
  });

  const commentTool = getTool(tools, "comment");
  await commentTool.execute("", {
    path: "src/index.ts",
    line: 1,
    side: "LEFT",
    body: "Old line",
  });
  await commentTool.execute("", {
    path: "src/index.ts",
    line: 1,
    side: "RIGHT",
    body: "New line",
  });

  expect(calls.length).toBe(2);
  expect(calls[0].type).toBe("comment");
  expect(calls[1].type).toBe("comment");
});

test("comment tool allows replies by thread_id even when line not in diff", async () => {
  const patch = `@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n`;
  const { octokit, calls } = makeOctokitSpy();
  const tools = createReviewTools({
    octokit: octokit as any,
    owner: "o",
    repo: "r",
    pullNumber: 1,
    headSha: "sha",
    modelId: "model",
    reviewSha: "sha",
    changedFiles: [{ filename: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch }],
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments: [],
    reviewThreads: [
      {
        id: 101,
        path: "src/index.ts",
        line: 1,
        side: "RIGHT",
        isOutdated: false,
        resolved: false,
        lastUpdatedAt: "2026-01-06T00:00:00Z",
        lastActor: "dev",
        rootCommentId: 500,
        url: "https://example.com/thread/101",
      },
    ],
  });

  const commentTool = getTool(tools, "comment");
  await commentTool.execute("", {
    path: "src/index.ts",
    line: 999,
    thread_id: 101,
    body: "Follow-up reply",
  });

  expect(calls.length).toBe(1);
  expect(calls[0].type).toBe("reply");
  expect(calls[0].args.comment_id).toBe(500);
});

test("suggest tool allows replies by thread_id even when line not in diff", async () => {
  const patch = `@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n`;
  const { octokit, calls } = makeOctokitSpy();
  const tools = createReviewTools({
    octokit: octokit as any,
    owner: "o",
    repo: "r",
    pullNumber: 1,
    headSha: "sha",
    modelId: "model",
    reviewSha: "sha",
    changedFiles: [{ filename: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch }],
    getBilling: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
    existingComments: [],
    reviewThreads: [
      {
        id: 102,
        path: "src/index.ts",
        line: 1,
        side: "RIGHT",
        isOutdated: false,
        resolved: false,
        lastUpdatedAt: "2026-01-06T00:00:00Z",
        lastActor: "dev",
        rootCommentId: 501,
        url: "https://example.com/thread/102",
      },
    ],
  });

  const suggestTool = getTool(tools, "suggest");
  await suggestTool.execute("", {
    path: "src/index.ts",
    line: 999,
    thread_id: 102,
    suggestion: "const a = 3;",
  });

  expect(calls.length).toBe(1);
  expect(calls[0].type).toBe("reply");
  expect(calls[0].args.comment_id).toBe(501);
});
