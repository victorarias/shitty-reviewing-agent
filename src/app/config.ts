import * as core from "@actions/core";
import fs from "node:fs";
import path from "node:path";
import type { ReviewConfig } from "../types.js";

export function readConfig(): ReviewConfig {
  const providerRaw = core.getInput("provider", { required: true });
  const provider = normalizeProvider(providerRaw);
  const apiKey = core.getInput("api-key");
  const modelId = core.getInput("model", { required: true });
  const compactionModel = core.getInput("compaction-model") || "";
  const maxFilesRaw = core.getInput("max-files") || "50";
  const debugRaw = core.getInput("debug") || "false";
  const reasoningRaw = core.getInput("reasoning") || "off";
  const temperatureRaw = core.getInput("temperature") || "";
  const debug = debugRaw.toLowerCase() === "true";
  const maxFiles = Number.parseInt(maxFilesRaw, 10);
  if (!Number.isFinite(maxFiles) || maxFiles <= 0) {
    throw new Error(`Invalid max-files: ${maxFilesRaw}`);
  }
  const reasoning = parseReasoning(reasoningRaw);
  const temperature = temperatureRaw ? Number.parseFloat(temperatureRaw) : undefined;
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new Error(`Invalid temperature: ${temperatureRaw}`);
  }

  const ignorePatternsRaw = core.getInput("ignore-patterns") || "";
  const ignorePatterns = ignorePatternsRaw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
  const gitDir = path.join(repoRoot, ".git");
  if (!fs.existsSync(gitDir)) {
    throw new Error("Checkout missing. Ensure actions/checkout ran before this action.");
  }
  if (!apiKey && provider !== "google-vertex") {
    throw new Error("api-key is required for this provider. For Vertex AI, omit api-key and use ADC.");
  }

  return {
    provider,
    apiKey: apiKey || "",
    modelId,
    compactionModel: compactionModel.trim() ? compactionModel.trim() : undefined,
    maxFiles,
    ignorePatterns,
    repoRoot,
    debug,
    reasoning,
    temperature,
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
