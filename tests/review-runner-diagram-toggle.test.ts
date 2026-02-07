import { expect, test } from "bun:test";
import { shouldGenerateLegacySequenceDiagram } from "../src/agent/review-runner.ts";
import type { ReviewConfig } from "../src/types.ts";

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

test("legacy sequence diagram is enabled only when directory threshold is exceeded and experimental explainer is off", () => {
  expect(shouldGenerateLegacySequenceDiagram(baseConfig, 3)).toBe(false);
  expect(shouldGenerateLegacySequenceDiagram(baseConfig, 4)).toBe(true);
});

test("legacy sequence diagram is disabled when experimental explainer is enabled", () => {
  const config: ReviewConfig = {
    ...baseConfig,
    experimentalPrExplainer: true,
  };
  expect(shouldGenerateLegacySequenceDiagram(config, 10)).toBe(false);
});
