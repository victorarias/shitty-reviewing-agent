import * as core from "@actions/core";
import fs from "node:fs";
import path from "node:path";
import { readReviewerc } from "./reviewerc.js";
import type { ActionConfig, CommentType, ReviewConfig, ToolCategory } from "../types.js";

const DEFAULT_IGNORE_PATTERNS = "*.lock,*.generated.*";
const DEFAULT_MAX_FILES = 50;
const DEFAULT_COMMENT_TYPE: CommentType = "both";
const DEFAULT_TOOLS_ALLOWLIST: ToolCategory[] = [
  "agent.subagent",
  "filesystem",
  "git.read",
  "git.history",
  "github.pr.read",
  "github.pr.feedback",
  "github.pr.manage",
  "repo.write",
];

function getOptionalInput(name: string): string | undefined {
  const raw = core.getInput(name);
  const trimmed = raw?.trim() ?? "";
  return trimmed ? trimmed : undefined;
}

export function readConfig(): ActionConfig {
  const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
  const gitDir = path.join(repoRoot, ".git");
  if (!fs.existsSync(gitDir)) {
    throw new Error("Checkout missing. Ensure actions/checkout ran before this action.");
  }

  const reviewerc = readReviewerc(repoRoot);
  const reviewDefaults = reviewerc?.review?.defaults ?? {};

  const providerInput = getOptionalInput("provider");
  const modelInput = getOptionalInput("model");
  const apiKeyInput = getOptionalInput("api-key") ?? "";
  const compactionModelInput = getOptionalInput("compaction-model");
  const maxFilesInput = getOptionalInput("max-files");
  const ignorePatternsInput = getOptionalInput("ignore-patterns");
  const debugInput = getOptionalInput("debug");
  const reasoningInput = getOptionalInput("reasoning");
  const temperatureInput = getOptionalInput("temperature");
  const botNameInput = getOptionalInput("bot-name");
  const allowPrToolsInput = getOptionalInput("allow-pr-tools");

  const providerRaw = providerInput ?? reviewDefaults.provider ?? "";
  if (!providerRaw) {
    throw new Error("Missing provider. Set action input provider or review.defaults.provider in .reviewerc.");
  }
  const provider = normalizeProvider(providerRaw);

  const modelId = modelInput ?? reviewDefaults.model ?? "";
  if (!modelId) {
    throw new Error("Missing model. Set action input model or review.defaults.model in .reviewerc.");
  }

  const maxFilesRaw = maxFilesInput ?? String(DEFAULT_MAX_FILES);
  const maxFiles = Number.parseInt(maxFilesRaw, 10);
  if (!Number.isFinite(maxFiles) || maxFiles <= 0) {
    throw new Error(`Invalid max-files: ${maxFilesRaw}`);
  }

  const ignorePatternsRaw = ignorePatternsInput ?? DEFAULT_IGNORE_PATTERNS;
  const ignorePatterns = ignorePatternsRaw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  const debug = debugInput ? debugInput.toLowerCase() === "true" : false;
  const reasoningValue = reasoningInput ?? reviewDefaults.reasoning ?? "off";
  const reasoning = parseReasoning(reasoningValue);

  const temperatureRaw = temperatureInput ?? (reviewDefaults.temperature !== undefined ? String(reviewDefaults.temperature) : "");
  const temperature = temperatureRaw ? Number.parseFloat(temperatureRaw) : undefined;
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new Error(`Invalid temperature: ${temperatureRaw}`);
  }

  const allowPrTools =
    allowPrToolsInput !== undefined
      ? allowPrToolsInput.toLowerCase() === "true"
      : reviewerc?.review?.allowPrToolsInReview ?? false;

  if (!apiKeyInput && provider !== "google-vertex") {
    throw new Error("api-key is required for non-Vertex providers. For Vertex AI, api-key is optional (ADC or key).");
  }

  const review: ReviewConfig = {
    provider,
    apiKey: apiKeyInput ?? "",
    modelId,
    compactionModel: compactionModelInput ? compactionModelInput.trim() : undefined,
    maxFiles,
    ignorePatterns,
    repoRoot,
    debug,
    reasoning,
    temperature,
    allowPrToolsInReview: allowPrTools,
  };

  return {
    review,
    reviewRun: reviewerc?.review?.run ?? [],
    commands: reviewerc?.commands ?? [],
    schedule: reviewerc?.schedule,
    toolsAllowlist: reviewerc?.tools?.allowlist ?? DEFAULT_TOOLS_ALLOWLIST,
    outputCommentType: reviewerc?.output?.commentType ?? DEFAULT_COMMENT_TYPE,
    botName: botNameInput,
  };
}

export function parseReasoning(value: string): ReviewConfig["reasoning"] {
  switch (value.toLowerCase()) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return value.toLowerCase() as ReviewConfig["reasoning"];
    default:
      throw new Error(`Invalid reasoning level: ${value}`);
  }
}

export function normalizeProvider(value: string): string {
  const lowered = value.trim().toLowerCase();
  const aliases: Record<string, string> = {
    gemini: "google",
    vertex: "google-vertex",
    vertexai: "google-vertex",
    "vertex-ai": "google-vertex",
    claude: "anthropic",
    gpt: "openai",
    chatgpt: "openai",
  };
  return aliases[lowered] ?? value.trim();
}
