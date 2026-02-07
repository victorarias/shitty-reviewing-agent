import { test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { TOOL_CATEGORY_BY_NAME } from "../src/tools/categories.ts";
import { buildSystemPrompt } from "../src/prompts/review.ts";
import { runCommand } from "../src/commands/command-runner.ts";
import type { ReviewConfig, ReviewContext, PullRequestInfo, ChangedFile, CommandDefinition } from "../src/types.ts";

function readmeToolInventory(): Set<string> {
  const readmePath = path.join(process.cwd(), "README.md");
  const text = fs.readFileSync(readmePath, "utf8");
  const toolsSection = text.split("## Tools")[1];
  if (!toolsSection) {
    throw new Error("README Tools section not found");
  }
  const section = toolsSection.split("\n## ")[0] ?? "";
  const tools = new Set<string>();
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) continue;
    const matches = [...trimmed.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    for (const token of matches) {
      if (token.includes(".")) continue; // skip category names like git.history
      tools.add(token);
    }
  }
  return tools;
}

test("README tools inventory includes all tool names", () => {
  const listed = readmeToolInventory();
  const tools = Object.keys(TOOL_CATEGORY_BY_NAME);
  for (const tool of tools) {
    expect(listed.has(tool)).toBe(true);
  }
});

test("system prompts only mention available tools", async () => {
  expect(buildSystemPrompt(["git"])).toContain("Git tool schema:");
  expect(buildSystemPrompt([])).not.toContain("Git tool schema:");
  expect(buildSystemPrompt(["post_summary"])).toContain("post_summary");
  expect(buildSystemPrompt([])).not.toContain("post_summary");
  expect(buildSystemPrompt([])).toContain("Never post a suggestion block that keeps code unchanged");
  expect(buildSystemPrompt([])).toContain("No jokes, metaphors, mascots, or unrelated flavor text");
  expect(buildSystemPrompt([])).not.toContain("farm-animal reference");

  const baseConfig: ReviewConfig = {
    provider: "google",
    apiKey: "test",
    modelId: "model",
    maxFiles: 10,
    ignorePatterns: [],
    repoRoot: process.cwd(),
    debug: false,
    reasoning: "off",
  };
  const baseContext: ReviewContext = { owner: "o", repo: "r", prNumber: 1 };
  const basePrInfo: PullRequestInfo = {
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
  const baseFiles: ChangedFile[] = [
    { filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch: "@@ -1 +1 @@\n-const a=1;\n+const a=2;\n" },
  ];
  const command: CommandDefinition = { id: "security", prompt: "Check" };

  let capturedPrompt = "";
  await runCommand({
    mode: "pr",
    command,
    config: baseConfig,
    context: baseContext,
    octokit: {} as any,
    prInfo: basePrInfo,
    changedFiles: baseFiles,
    existingComments: [],
    reviewThreads: [],
    commentType: "issue",
    allowlist: ["filesystem", "git.history", "github.pr.feedback"],
    overrides: {
      model: { contextWindow: 1000 } as any,
      compactionModel: null,
      agentFactory: ({ initialState }: any) => {
        capturedPrompt = initialState.systemPrompt;
        return {
          state: { error: null, messages: [] },
          subscribe() {},
          async prompt() {},
          abort() {},
        };
      },
    },
  });

  expect(capturedPrompt).toContain("Git tool schema:");
  expect(capturedPrompt).toContain("post_summary");

  let capturedPromptNoGit = "";
  await runCommand({
    mode: "pr",
    command,
    config: baseConfig,
    context: baseContext,
    octokit: {} as any,
    prInfo: basePrInfo,
    changedFiles: baseFiles,
    existingComments: [],
    reviewThreads: [],
    commentType: "issue",
    allowlist: ["filesystem"],
    overrides: {
      model: { contextWindow: 1000 } as any,
      compactionModel: null,
      agentFactory: ({ initialState }: any) => {
        capturedPromptNoGit = initialState.systemPrompt;
        return {
          state: { error: null, messages: [] },
          subscribe() {},
          async prompt() {},
          abort() {},
        };
      },
    },
  });

  expect(capturedPromptNoGit).not.toContain("Git tool schema:");
  expect(capturedPromptNoGit).not.toContain("post_summary");
});
