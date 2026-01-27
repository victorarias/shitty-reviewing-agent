import { test, expect } from "bun:test";
import { CommandRegistry } from "../src/commands/registry.ts";
import { parseCommandInvocation } from "../src/commands/args.ts";
import { runActionFlow } from "../src/app/flow.ts";
import type { ReviewConfig, ReviewContext } from "../src/types.ts";

const commandDef = { id: "security", prompt: "Check auth" } as const;

test("command registry lookup returns command", () => {
  const registry = new CommandRegistry([commandDef as any]);
  expect(registry.get("security")).toBeDefined();
});

test("command registry rejects duplicate ids", () => {
  expect(() => new CommandRegistry([commandDef as any, commandDef as any])).toThrow();
});

test("parseCommandInvocation handles quoted args", () => {
  const invocation = parseCommandInvocation('!docs-drift "last 48 hours" --scope docs/');
  expect(invocation).not.toBeNull();
  expect(invocation?.command).toBe("docs-drift");
  expect(invocation?.args).toBe('"last 48 hours" --scope docs/');
  expect(invocation?.argv).toEqual(["last 48 hours", "--scope", "docs/"]);
});

test("parseCommandInvocation handles @mention form", () => {
  const invocation = parseCommandInvocation('@reviewer security "quick"');
  expect(invocation).not.toBeNull();
  expect(invocation?.command).toBe("security");
  expect(invocation?.mention).toBe("reviewer");
  expect(invocation?.argv).toEqual(["quick"]);
});

test("runActionFlow logs missing command id", async () => {
  const config: ReviewConfig = {
    provider: "google",
    apiKey: "test",
    modelId: "model",
    maxFiles: 5,
    ignorePatterns: [],
    repoRoot: process.cwd(),
    debug: false,
    reasoning: "off",
  };
  const context: ReviewContext = { owner: "o", repo: "r", prNumber: 1 };
  let message = "";
  await runActionFlow({
    config,
    context,
    octokit: {} as any,
    fetchPrDataFn: async () => ({
      prInfo: {
        number: 1,
        title: "PR",
        body: "",
        author: "author",
        baseRef: "main",
        headRef: "feature",
        baseSha: "base",
        headSha: "head",
        url: "https://example.com/pr/1",
      },
      changedFiles: [],
    }),
    fetchExistingCommentsFn: async () => ({ existingComments: [], reviewThreads: [] }),
    runReviewFn: async () => {},
    commandIds: ["missing"],
    commandRegistry: new CommandRegistry([]),
    runCommandFn: async () => {},
    toolsAllowlist: ["filesystem", "git.read", "git.history", "github.read", "github.write", "repo.write"],
    defaultCommentType: "both",
    logInfo: (msg) => {
      message = msg;
    },
  });
  expect(message).toContain("Unknown command id");
});
