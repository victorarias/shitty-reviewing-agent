import { test, expect } from "bun:test";
import { buildSummaryMarkdown } from "../src/summary.ts";
import { buildUserPrompt } from "../src/prompt.ts";

test("buildSummaryMarkdown adds footer + marker", () => {
  const body = buildSummaryMarkdown({
    verdict: "Approve",
    issues: ["None"],
    keyFindings: ["None"],
    multiFileSuggestions: ["None"],
    model: "test-model",
    reviewSha: "abc1234",
    billing: { input: 1, output: 2, total: 3, cost: 0.001 },
  });

  expect(body).toContain("Reviewed by shitty-reviewing-agent");
  expect(body).toContain("sri:bot-comment");
  expect(body).toContain("sri:last-reviewed-sha:abc1234");
  expect(body).toContain("Billing: input 1");
});

test("buildUserPrompt includes context", () => {
  const prompt = buildUserPrompt({
    prTitle: "Test",
    prBody: "Body",
    changedFiles: ["src/index.ts"],
    maxFiles: 50,
    ignorePatterns: ["*.lock"],
    existingComments: 3,
    lastReviewedSha: "deadbeef",
    headSha: "cafebabe",
  });

  expect(prompt).toContain("Existing PR comments");
  expect(prompt).toContain("Last reviewed SHA: deadbeef");
  expect(prompt).toContain("Current head SHA: cafebabe");
});
