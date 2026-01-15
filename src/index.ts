import * as core from "@actions/core";
import * as github from "@actions/github";
import { createAppAuth } from "@octokit/auth-app";
import fs from "node:fs";
import path from "node:path";
import { runReview } from "./agent.js";
import type { ChangedFile, PullRequestInfo, ReviewConfig, ReviewContext } from "./types.js";
import { minimatch } from "minimatch";

async function main(): Promise<void> {
  try {
    const config = readConfig();
    const context = readContext();
    const { token, authType } = await resolveGithubAuth();
    const octokit = github.getOctokit(token);
    if (config.debug) {
      core.info(`[debug] GitHub auth: ${authType}`);
    }
    const { prInfo, changedFiles } = await fetchPrData(octokit, context);
    if (config.debug) {
      core.info(`[debug] PR #${prInfo.number} ${prInfo.title}`);
      core.info(`[debug] Files in PR: ${changedFiles.length}`);
    }

    const filtered = applyIgnorePatterns(changedFiles, config.ignorePatterns);
    if (filtered.length > config.maxFiles) {
      await postSkipSummary(octokit, context, config.modelId, filtered.length, config.maxFiles);
      return;
    }

    await runReview({
      config,
      context,
      octokit,
      prInfo,
      changedFiles: filtered,
    });
  } catch (error: any) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

function readConfig(): ReviewConfig {
  const providerRaw = core.getInput("provider", { required: true });
  const provider = normalizeProvider(providerRaw);
  const apiKey = core.getInput("api-key");
  const modelId = core.getInput("model", { required: true });
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
    maxFiles,
    ignorePatterns,
    repoRoot,
    debug,
    reasoning,
    temperature,
  };
}

function parseReasoning(value: string): ReviewConfig["reasoning"] {
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

function normalizeProvider(value: string): string {
  const lowered = value.trim().toLowerCase();
  if (lowered === "gemini") {
    return "google";
  }
  if (lowered === "vertex" || lowered === "vertexai" || lowered === "vertex-ai") {
    return "google-vertex";
  }
  return value.trim();
}

async function resolveGithubAuth(): Promise<{ token: string; authType: string }> {
  const appId = core.getInput("app-id");
  const installationIdRaw = core.getInput("app-installation-id");
  const privateKey = core.getInput("app-private-key");

  if (appId && installationIdRaw && privateKey) {
    const installationId = Number.parseInt(installationIdRaw, 10);
    if (!Number.isFinite(installationId)) {
      throw new Error(`Invalid app-installation-id: ${installationIdRaw}`);
    }
    const auth = createAppAuth({
      appId,
      privateKey,
      installationId,
    });
    const { token } = await auth({ type: "installation" });
    return { token, authType: "github-app" };
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is required (or provide GitHub App credentials).");
  }
  return { token, authType: "github-token" };
}

function readContext(): ReviewContext {
  const ctx = github.context;
  const prNumber = ctx.payload.pull_request?.number ?? ctx.payload.issue?.number;
  if (!prNumber) {
    throw new Error("No pull request found in event payload.");
  }
  return {
    owner: ctx.repo.owner,
    repo: ctx.repo.repo,
    prNumber,
  };
}

async function fetchPrData(octokit: ReturnType<typeof github.getOctokit>, context: ReviewContext): Promise<{ prInfo: PullRequestInfo; changedFiles: ChangedFile[] }> {
  const pr = await octokit.rest.pulls.get({
    owner: context.owner,
    repo: context.repo,
    pull_number: context.prNumber,
  });

  const prInfo: PullRequestInfo = {
    number: pr.data.number,
    title: pr.data.title ?? "",
    body: pr.data.body ?? "",
    author: pr.data.user?.login ?? "unknown",
    baseRef: pr.data.base?.ref ?? "",
    headRef: pr.data.head?.ref ?? "",
    baseSha: pr.data.base?.sha ?? "",
    headSha: pr.data.head?.sha ?? "",
    url: pr.data.html_url ?? "",
  };

  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: context.owner,
    repo: context.repo,
    pull_number: context.prNumber,
    per_page: 100,
  });

  const changedFiles: ChangedFile[] = files.map((file) => ({
    filename: file.filename,
    status: file.status,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    changes: file.changes ?? 0,
    patch: file.patch,
    previous_filename: file.previous_filename,
  }));

  return { prInfo, changedFiles };
}

function applyIgnorePatterns(files: ChangedFile[], patterns: string[]): ChangedFile[] {
  if (patterns.length === 0) return files;
  return files.filter((file) => !patterns.some((pattern) => minimatch(file.filename, pattern)));
}

async function postSkipSummary(
  octokit: ReturnType<typeof github.getOctokit>,
  context: ReviewContext,
  modelId: string,
  fileCount: number,
  maxFiles: number
): Promise<void> {
  await octokit.rest.issues.createComment({
    owner: context.owner,
    repo: context.repo,
    issue_number: context.prNumber,
    body: buildSummaryMarkdown({
      verdict: "Skipped",
      issues: [`PR has ${fileCount} files after filtering; max allowed is ${maxFiles}.`],
      keyFindings: ["None"],
      multiFileSuggestions: ["None"],
      model: modelId,
    }),
  });
}

export interface SummaryContent {
  verdict: string;
  issues: string[];
  keyFindings: string[];
  multiFileSuggestions: string[];
  model: string;
  billing?: {
    input: number;
    output: number;
    total: number;
    cost: number;
  };
}

export function buildSummaryMarkdown(content: SummaryContent): string {
  const billing = content.billing
    ? `\n*Billing: input ${content.billing.input} • output ${content.billing.output} • total ${content.billing.total} • cost $${content.billing.cost.toFixed(6)}*`
    : "";
  const multiFile = renderOptionalSection("Multi-file Suggestions", content.multiFileSuggestions);
  return `## Review Summary\n\n**Verdict:** ${content.verdict}\n\n### Issues Found\n\n${renderList(content.issues)}\n\n### Key Findings\n\n${renderList(content.keyFindings)}\n${multiFile}\n---\n*Reviewed by shitty-reviewing-agent • model: ${content.model}*${billing}`;
}

function renderList(items: string[]): string {
  if (!items || items.length === 0) {
    return "- None";
  }
  return items.map((item) => `- ${item}`).join("\n");
}

function renderOptionalSection(title: string, items: string[]): string {
  if (!items || items.length === 0 || items.every((item) => item.trim().toLowerCase() === "none")) {
    return "";
  }
  return `\n### ${title}\n\n${renderList(items)}\n`;
}

main();
