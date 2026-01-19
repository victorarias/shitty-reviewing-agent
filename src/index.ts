import * as core from "@actions/core";
import * as github from "@actions/github";
import { createAppAuth } from "@octokit/auth-app";
import fs from "node:fs";
import path from "node:path";
import { runReview } from "./agent.js";
import type { ChangedFile, ExistingComment, PullRequestInfo, ReviewConfig, ReviewContext } from "./types.js";
import { buildSummaryMarkdown } from "./summary.js";
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
    const existingComments = await fetchExistingComments(octokit, context);
    const lastReviewedSha = findLastReviewedSha(existingComments);
    const scopedFiles = lastReviewedSha
      ? await fetchChangesSinceReview(octokit, context, lastReviewedSha, prInfo.headSha)
      : changedFiles;
    if (config.debug) {
      core.info(`[debug] PR #${prInfo.number} ${prInfo.title}`);
      core.info(`[debug] Files in PR: ${changedFiles.length}`);
      if (lastReviewedSha) {
        core.info(`[debug] Last reviewed SHA: ${lastReviewedSha}`);
        core.info(`[debug] Files since last review: ${scopedFiles.length}`);
      }
      core.info(`[debug] Existing comments: ${existingComments.length}`);
    }

    const filtered = applyIgnorePatterns(scopedFiles, config.ignorePatterns);
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
      existingComments,
      lastReviewedSha,
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

async function fetchExistingComments(
  octokit: ReturnType<typeof github.getOctokit>,
  context: ReviewContext
): Promise<ExistingComment[]> {
  const [issueComments, reviewComments] = await Promise.all([
    octokit.paginate(octokit.rest.issues.listComments, {
      owner: context.owner,
      repo: context.repo,
      issue_number: context.prNumber,
      per_page: 100,
    }),
    octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner: context.owner,
      repo: context.repo,
      pull_number: context.prNumber,
      per_page: 100,
    }),
  ]);

  const normalizedIssue = issueComments.map((comment) => ({
    id: comment.id,
    author: comment.user?.login ?? "unknown",
    body: comment.body ?? "",
    url: comment.html_url ?? "",
    type: "issue" as const,
    updatedAt: comment.updated_at ?? comment.created_at ?? "",
  }));

  const normalizedReview = reviewComments.map((comment) => ({
    id: comment.id,
    author: comment.user?.login ?? "unknown",
    body: comment.body ?? "",
    url: comment.html_url ?? "",
    type: "review" as const,
    path: comment.path ?? undefined,
    line: comment.line ?? undefined,
    inReplyToId: comment.in_reply_to_id ?? undefined,
    updatedAt: comment.updated_at ?? comment.created_at ?? "",
  }));

  return [...normalizedIssue, ...normalizedReview];
}

function findLastReviewedSha(comments: ExistingComment[]): string | null {
  const marker = "<!-- sri:last-reviewed-sha:";
  const candidates = comments
    .filter((comment) => comment.type === "issue" && comment.body.includes(marker))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const comment of candidates) {
    const match = comment.body.match(/<!--\\s*sri:last-reviewed-sha:([a-f0-9]{7,40})\\s*-->/i);
    if (match) {
      return match[1];
    }
  }
  return null;
}

async function fetchChangesSinceReview(
  octokit: ReturnType<typeof github.getOctokit>,
  context: ReviewContext,
  baseSha: string,
  headSha: string
): Promise<ChangedFile[]> {
  if (baseSha === headSha) return [];
  const comparison = await octokit.rest.repos.compareCommits({
    owner: context.owner,
    repo: context.repo,
    base: baseSha,
    head: headSha,
  });
  const files = comparison.data.files ?? [];
  return files.map((file) => ({
    filename: file.filename,
    status: file.status as ChangedFile["status"],
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    changes: file.changes ?? 0,
    patch: file.patch,
    previous_filename: file.previous_filename,
  }));
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

export { buildSummaryMarkdown } from "./summary.js";

main();
