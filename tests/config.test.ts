import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeProvider, parseReasoning, readConfig } from "../src/app/config.ts";

test("normalizeProvider maps common aliases", () => {
  expect(normalizeProvider("gemini")).toBe("google");
  expect(normalizeProvider("vertex")).toBe("google-vertex");
  expect(normalizeProvider("gpt")).toBe("openai");
  expect(normalizeProvider("anthropic")).toBe("anthropic");
});

test("parseReasoning accepts known levels", () => {
  expect(parseReasoning("off")).toBe("off");
  expect(parseReasoning("LOW")).toBe("low");
  expect(parseReasoning("xhigh")).toBe("xhigh");
});

test("readConfig merges .reviewerc defaults with action inputs", () => {
  const repoRoot = makeTempRepo();
  fs.writeFileSync(
    path.join(repoRoot, ".reviewerc"),
    [
      "version: 1",
      "review:",
      "  defaults:",
      "    provider: openrouter",
      "    model: anthropic/claude-sonnet-4",
      "    reasoning: medium",
      "    temperature: 0.4",
      "commands: []",
    ].join("\n"),
    "utf8"
  );

  const config = withEnv(
    {
      GITHUB_WORKSPACE: repoRoot,
      "INPUT_PROVIDER": "google",
      "INPUT_MODEL": "gemini-3-pro-preview",
      "INPUT_API-KEY": "test",
    },
    () => readConfig()
  );

  expect(config.review.provider).toBe("google");
  expect(config.review.modelId).toBe("gemini-3-pro-preview");
  expect(config.review.reasoning).toBe("medium");
  expect(config.review.temperature).toBe(0.4);
});

test("readConfig allows api-key for google-vertex", () => {
  const repoRoot = makeTempRepo();
  const config = withEnv(
    {
      GITHUB_WORKSPACE: repoRoot,
      "INPUT_PROVIDER": "google-vertex",
      "INPUT_MODEL": "gemini-2.5-flash",
      "INPUT_API-KEY": "vertex-key",
    },
    () => readConfig()
  );

  expect(config.review.provider).toBe("google-vertex");
  expect(config.review.apiKey).toBe("vertex-key");
});

test("readConfig does not require api-key for google-vertex", () => {
  const repoRoot = makeTempRepo();
  const config = withEnv(
    {
      GITHUB_WORKSPACE: repoRoot,
      "INPUT_PROVIDER": "google-vertex",
      "INPUT_MODEL": "gemini-2.5-flash",
    },
    () => readConfig()
  );

  expect(config.review.provider).toBe("google-vertex");
  expect(config.review.apiKey).toBe("");
});

test("readConfig enables PR tools when allow-pr-tools input is true", () => {
  const repoRoot = makeTempRepo();
  const config = withEnv(
    {
      GITHUB_WORKSPACE: repoRoot,
      "INPUT_PROVIDER": "google",
      "INPUT_MODEL": "gemini-3-pro-preview",
      "INPUT_API-KEY": "test",
      "INPUT_ALLOW-PR-TOOLS": "true",
    },
    () => readConfig()
  );

  expect(config.review.allowPrToolsInReview).toBe(true);
});

test("readConfig rejects invalid YAML", () => {
  const repoRoot = makeTempRepo();
  fs.writeFileSync(path.join(repoRoot, ".reviewerc"), "version: [", "utf8");

  const error = withEnv(
    {
      GITHUB_WORKSPACE: repoRoot,
      "INPUT_PROVIDER": "google",
      "INPUT_MODEL": "gemini-3-pro-preview",
      "INPUT_API-KEY": "test",
    },
    () => {
      try {
        readConfig();
      } catch (err: any) {
        return err;
      }
      return null;
    }
  );

  expect(error).not.toBeNull();
  expect(String(error?.message)).toContain("Invalid YAML");
});

test("readConfig rejects schema violations", () => {
  const repoRoot = makeTempRepo();
  fs.writeFileSync(path.join(repoRoot, ".reviewerc"), "review: {}", "utf8");

  const error = withEnv(
    {
      GITHUB_WORKSPACE: repoRoot,
      "INPUT_PROVIDER": "google",
      "INPUT_MODEL": "gemini-3-pro-preview",
      "INPUT_API-KEY": "test",
    },
    () => {
      try {
        readConfig();
      } catch (err: any) {
        return err;
      }
      return null;
    }
  );

  expect(error).not.toBeNull();
  expect(String(error?.message)).toContain("Invalid .reviewerc");
});

test("readConfig rejects removed keys", () => {
  const repoRoot = makeTempRepo();
  fs.writeFileSync(
    path.join(repoRoot, ".reviewerc"),
    [
      "version: 1",
      "schedule:",
      "  output:",
      "    type: pr",
    ].join("\n"),
    "utf8"
  );

  const error = withEnv(
    {
      GITHUB_WORKSPACE: repoRoot,
      "INPUT_PROVIDER": "google",
      "INPUT_MODEL": "gemini-3-pro-preview",
      "INPUT_API-KEY": "test",
    },
    () => {
      try {
        readConfig();
      } catch (err: any) {
        return err;
      }
      return null;
    }
  );

  expect(error).not.toBeNull();
  expect(String(error?.message)).toContain("schedule.output");
});

function makeTempRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sra-config-"));
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
  return repoRoot;
}

function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const previous = { ...process.env };
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    process.env = previous;
  }
}
