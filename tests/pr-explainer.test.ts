import { expect, test } from "bun:test";
import {
  buildFileGuideMarker,
  findPreferredInlineAnchor,
  maybePostPrExplainer,
  REVIEW_GUIDE_FAILURE_MARKER,
  REVIEW_GUIDE_MARKER,
} from "../src/agent/pr-explainer.ts";
import type { ChangedFile, ExistingComment, PullRequestInfo, ReviewConfig } from "../src/types.ts";

function makeOctokitSpy(options: { createReviewCommentError?: any } = {}) {
  const calls: Array<{ type: string; args: any }> = [];
  const octokit = {
    rest: {
      issues: {
        createComment: async (args: any) => {
          calls.push({ type: "issue_create", args });
          return { data: { id: 1 } };
        },
        updateComment: async (args: any) => {
          calls.push({ type: "issue_update", args });
          return { data: { id: args.comment_id } };
        },
      },
      pulls: {
        createReviewComment: async (args: any) => {
          if (options.createReviewCommentError) {
            throw options.createReviewCommentError;
          }
          calls.push({ type: "review_create", args });
          return { data: { id: 2 } };
        },
        updateReviewComment: async (args: any) => {
          calls.push({ type: "review_update", args });
          return { data: { id: args.comment_id } };
        },
        deleteReviewComment: async (args: any) => {
          calls.push({ type: "review_delete", args });
          return { data: {} };
        },
      },
    },
  };
  return { octokit, calls };
}

const baseConfig: ReviewConfig = {
  provider: "google",
  apiKey: "test",
  modelId: "model",
  maxFiles: 50,
  ignorePatterns: [],
  repoRoot: process.cwd(),
  debug: false,
  reasoning: "off",
  experimentalPrExplainer: true,
};

const basePrInfo: PullRequestInfo = {
  number: 7,
  title: "Improve reviewer outputs",
  body: "Adds richer review assistance.",
  author: "victor",
  baseRef: "main",
  headRef: "feature",
  baseSha: "base",
  headSha: "head",
  url: "https://example.com/pr/7",
};

test("maybePostPrExplainer posts guide and file-level review comment", async () => {
  const { octokit, calls } = makeOctokitSpy();
  const changedFiles: ChangedFile[] = [
    {
      filename: "src/index.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: "@@ -1,1 +1,2 @@\n const a = 1;\n+const b = 2;\n",
    },
  ];

  await maybePostPrExplainer({
    enabled: true,
    model: { contextWindow: 1000 },
    tools: [],
    config: baseConfig,
    octokit: octokit as any,
    owner: "o",
    repo: "r",
    pullNumber: 7,
    headSha: "head",
    prInfo: basePrInfo,
    changedFiles,
    existingComments: [],
    sequenceDiagram: null,
    effectiveThinkingLevel: "off",
    log: () => {},
    generateFn: async () => ({
      reviewGuide: "## Review Guide\nFocus on state and side effects.",
      fileComments: [
        {
          path: "src/index.ts",
          body: "### What this file does\n- Entry point.\n\n### What changed\n- Adds branch logic.\n\n### Why this changed\n- Needed for new flow.\n\n### Review checklist (high-risk focus)\n- [ ] Validate happy path.",
        },
      ],
    }),
  });

  expect(calls.length).toBe(2);
  expect(calls[0].type).toBe("issue_create");
  expect(calls[0].args.body).toContain(REVIEW_GUIDE_MARKER);
  expect(calls[1].type).toBe("review_create");
  expect(calls[1].args.path).toBe("src/index.ts");
  expect(calls[1].args.subject_type).toBe("file");
  expect(calls[1].args.body).toContain(buildFileGuideMarker("src/index.ts"));
});

test("maybePostPrExplainer falls back to issue comment when file-level and inline anchors are unavailable", async () => {
  const { octokit, calls } = makeOctokitSpy({
    createReviewCommentError: { status: 422, message: "line is required" },
  });
  const changedFiles: ChangedFile[] = [
    {
      filename: "assets/logo.png",
      status: "modified",
      additions: 0,
      deletions: 0,
      changes: 0,
      patch: undefined,
    },
  ];

  await maybePostPrExplainer({
    enabled: true,
    model: { contextWindow: 1000 },
    tools: [],
    config: baseConfig,
    octokit: octokit as any,
    owner: "o",
    repo: "r",
    pullNumber: 7,
    headSha: "head",
    prInfo: basePrInfo,
    changedFiles,
    existingComments: [],
    sequenceDiagram: null,
    effectiveThinkingLevel: "off",
    log: () => {},
    generateFn: async () => ({
      reviewGuide: "Guide",
      fileComments: [{ path: "assets/logo.png", body: "### What this file does\n- Binary asset." }],
    }),
  });

  expect(calls.length).toBe(2);
  expect(calls[0].type).toBe("issue_create");
  expect(calls[1].type).toBe("issue_create");
  expect(calls[1].args.body).toContain("### File guide: `assets/logo.png`");
});

test("maybePostPrExplainer updates existing guide and file comments when markers are present", async () => {
  const { octokit, calls } = makeOctokitSpy();
  const changedFiles: ChangedFile[] = [
    {
      filename: "src/index.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      changes: 3,
      patch: "@@ -1,1 +1,2 @@\n const a = 1;\n+const b = 2;\n",
    },
  ];
  const existingComments: ExistingComment[] = [
    {
      id: 11,
      author: "bot[bot]",
      authorType: "Bot",
      body: `Old guide\n\n${REVIEW_GUIDE_MARKER}\n\n<!-- sri:bot-comment -->`,
      url: "https://example.com/11",
      type: "issue",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    {
      id: 22,
      author: "bot[bot]",
      authorType: "Bot",
      body: `Old file\n\n${buildFileGuideMarker("src/index.ts")}\n\n<!-- sri:bot-comment -->`,
      url: "https://example.com/22",
      type: "review",
      path: "src/index.ts",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ];

  await maybePostPrExplainer({
    enabled: true,
    model: { contextWindow: 1000 },
    tools: [],
    config: baseConfig,
    octokit: octokit as any,
    owner: "o",
    repo: "r",
    pullNumber: 7,
    headSha: "head",
    prInfo: basePrInfo,
    changedFiles,
    existingComments,
    sequenceDiagram: null,
    effectiveThinkingLevel: "off",
    log: () => {},
    generateFn: async () => ({
      reviewGuide: "Updated guide",
      fileComments: [{ path: "src/index.ts", body: "Updated file guide" }],
    }),
  });

  expect(calls.length).toBe(2);
  expect(calls[0].type).toBe("issue_update");
  expect(calls[0].args.comment_id).toBe(11);
  expect(calls[1].type).toBe("review_update");
  expect(calls[1].args.comment_id).toBe(22);
});

test("maybePostPrExplainer strips high-risk checklist section when it contains low-risk content", async () => {
  const { octokit, calls } = makeOctokitSpy();
  const changedFiles: ChangedFile[] = [
    {
      filename: "docs/reviewerc.example.yml",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: "@@ -1,1 +1,2 @@\n version: 1\n+review:\n",
    },
  ];

  await maybePostPrExplainer({
    enabled: true,
    model: { contextWindow: 1000 },
    tools: [],
    config: baseConfig,
    octokit: octokit as any,
    owner: "o",
    repo: "r",
    pullNumber: 7,
    headSha: "head",
    prInfo: basePrInfo,
    changedFiles,
    existingComments: [],
    sequenceDiagram: null,
    effectiveThinkingLevel: "off",
    log: () => {},
    generateFn: async () => ({
      reviewGuide: "Guide",
      fileComments: [
        {
          path: "docs/reviewerc.example.yml",
          body: [
            "### What this file does",
            "- docs",
            "",
            "### What changed",
            "- adds config",
            "",
            "### Why this changed",
            "- document toggle",
            "",
            "### Review checklist (high-risk focus)",
            "- Low risk. Ensure this matches schema.",
          ].join("\n"),
        },
      ],
    }),
  });

  expect(calls.length).toBe(2);
  expect(calls[1].type).toBe("review_create");
  expect(calls[1].args.body).not.toContain("### Review checklist (high-risk focus)");
  expect(calls[1].args.body).not.toContain("Low risk. Ensure this matches schema.");
});

test("maybePostPrExplainer migrates legacy inline file guide comment to file-level comment", async () => {
  const { octokit, calls } = makeOctokitSpy();
  const changedFiles: ChangedFile[] = [
    {
      filename: "src/index.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      changes: 3,
      patch: "@@ -1,1 +1,2 @@\n const a = 1;\n+const b = 2;\n",
    },
  ];
  const existingComments: ExistingComment[] = [
    {
      id: 22,
      author: "bot[bot]",
      authorType: "Bot",
      body: `Old file\n\n${buildFileGuideMarker("src/index.ts")}\n\n<!-- sri:bot-comment -->`,
      url: "https://example.com/22",
      type: "review",
      path: "src/index.ts",
      line: 2,
      side: "RIGHT",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ];

  await maybePostPrExplainer({
    enabled: true,
    model: { contextWindow: 1000 },
    tools: [],
    config: baseConfig,
    octokit: octokit as any,
    owner: "o",
    repo: "r",
    pullNumber: 7,
    headSha: "head",
    prInfo: basePrInfo,
    changedFiles,
    existingComments,
    sequenceDiagram: null,
    effectiveThinkingLevel: "off",
    log: () => {},
    generateFn: async () => ({
      reviewGuide: "Guide",
      fileComments: [{ path: "src/index.ts", body: "Updated file guide" }],
    }),
  });

  expect(calls.length).toBe(3);
  expect(calls[0].type).toBe("issue_create");
  expect(calls[1].type).toBe("review_create");
  expect(calls[1].args.subject_type).toBe("file");
  expect(calls[2].type).toBe("review_delete");
  expect(calls[2].args.comment_id).toBe(22);
});

test("maybePostPrExplainer posts explicit failure signal when output is incomplete", async () => {
  const { octokit, calls } = makeOctokitSpy();
  const changedFiles: ChangedFile[] = [
    {
      filename: "src/index.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      changes: 3,
      patch: "@@ -1,1 +1,2 @@\n const a = 1;\n+const b = 2;\n",
    },
  ];

  await maybePostPrExplainer({
    enabled: true,
    model: { contextWindow: 1000 },
    tools: [],
    config: baseConfig,
    octokit: octokit as any,
    owner: "o",
    repo: "r",
    pullNumber: 7,
    headSha: "head",
    prInfo: basePrInfo,
    changedFiles,
    existingComments: [],
    sequenceDiagram: null,
    effectiveThinkingLevel: "off",
    log: () => {},
    generateFn: async () => ({
      reviewGuide: "Guide exists but file coverage is incomplete.",
      fileComments: [],
    }),
  });

  expect(calls.length).toBe(1);
  expect(calls[0].type).toBe("issue_create");
  expect(calls[0].args.body).toContain(REVIEW_GUIDE_FAILURE_MARKER);
  expect(calls[0].args.body).toContain("No synthetic explainer content was posted.");
});

test("maybePostPrExplainer posts explicit failure signal when output is missing", async () => {
  const { octokit, calls } = makeOctokitSpy();
  const changedFiles: ChangedFile[] = [
    {
      filename: "src/index.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: "@@ -1,1 +1,2 @@\n const a = 1;\n+const b = 2;\n",
    },
  ];

  await maybePostPrExplainer({
    enabled: true,
    model: { contextWindow: 1000 },
    tools: [],
    config: baseConfig,
    octokit: octokit as any,
    owner: "o",
    repo: "r",
    pullNumber: 7,
    headSha: "head",
    prInfo: basePrInfo,
    changedFiles,
    existingComments: [],
    sequenceDiagram: null,
    effectiveThinkingLevel: "off",
    log: () => {},
    generateFn: async () => null,
  });

  expect(calls.length).toBe(1);
  expect(calls[0].type).toBe("issue_create");
  expect(calls[0].args.body).toContain(REVIEW_GUIDE_FAILURE_MARKER);
});

test("findPreferredInlineAnchor prefers added RIGHT lines, then context, then deleted LEFT", () => {
  expect(findPreferredInlineAnchor("@@ -1,1 +1,2 @@\n const a = 1;\n+const b = 2;\n")).toEqual({ line: 2, side: "RIGHT" });
  expect(findPreferredInlineAnchor("@@ -3,2 +3,0 @@\n-const a = 1;\n-const b = 2;\n")).toEqual({ line: 3, side: "LEFT" });
});
