import { test, expect } from "bun:test";
import { resolveCompactionModel } from "../src/agent.ts";
import type { ReviewConfig } from "../src/types.ts";

function makeConfig(overrides: Partial<ReviewConfig>): ReviewConfig {
  return {
    provider: "openai",
    apiKey: "key",
    modelId: "gpt-4o",
    maxFiles: 50,
    ignorePatterns: [],
    repoRoot: ".",
    debug: false,
    reasoning: "off",
    temperature: undefined,
    ...overrides,
  };
}

test("uses explicit compaction-model when provided", () => {
  const config = makeConfig({ compactionModel: "custom-model", provider: "google" });
  expect(resolveCompactionModel(config)).toBe("custom-model");
});

test("defaults to gemini-3-flash-preview for google provider", () => {
  const config = makeConfig({ provider: "google", modelId: "gemini-3-pro-preview", compactionModel: undefined });
  expect(resolveCompactionModel(config)).toBe("gemini-3-flash-preview");
});

test("falls back to main model for non-google providers", () => {
  const config = makeConfig({ provider: "openai", modelId: "gpt-4o", compactionModel: undefined });
  expect(resolveCompactionModel(config)).toBe("gpt-4o");
});
