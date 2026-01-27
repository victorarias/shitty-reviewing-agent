import * as github from "@actions/github";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { minimatch } from "minimatch";
import type { ActionConfig, IncludeExclude } from "../types.js";
import { CommandRegistry } from "../commands/registry.js";
import { runCommand } from "../commands/run.js";
import { listBlockedPaths } from "./write-scope.js";

const execFileAsync = promisify(execFile);

export async function runScheduledFlow(params: {
  config: ActionConfig;
  octokit: ReturnType<typeof github.getOctokit>;
  commandRegistry?: CommandRegistry;
  runCommandFn?: typeof runCommand;
  logInfo?: (message: string) => void;
  logDebug?: (message: string) => void;
  listChangedFilesFn?: (repoRoot: string) => Promise<string[]>;
  getCurrentBranchFn?: (repoRoot: string) => Promise<string>;
  getDiffStatsFn?: (repoRoot: string) => Promise<DiffStats>;
  runGitFn?: (repoRoot: string, args: string[]) => Promise<void>;
}): Promise<void> {
  const logInfo = params.logInfo ?? console.info;
  const logDebug = params.logDebug ?? (() => {});
  const schedule = params.config.schedule;
  if (!schedule?.enabled) {
    logInfo("Schedule disabled or missing in .reviewerc.");
    return;
  }

  const jobId = process.env.GITHUB_JOB;
  if (!jobId) {
    logInfo("Missing GITHUB_JOB; skipping scheduled run.");
    return;
  }

  const commandIds = schedule.runs?.[jobId];
  if (!commandIds || commandIds.length === 0) {
    logInfo(`No schedule.runs mapping for job ${jobId}.`);
    return;
  }

  const registry = params.commandRegistry ?? new CommandRegistry(params.config.commands);
  const runCommandImpl = params.runCommandFn ?? runCommand;
  const listChangedFilesImpl = params.listChangedFilesFn ?? listChangedFiles;
  const getCurrentBranchImpl = params.getCurrentBranchFn ?? getCurrentBranch;
  const getDiffStatsImpl = params.getDiffStatsFn ?? getDiffStats;
  const runGitImpl = params.runGitFn ?? runGit;

  const currentBranch = await getCurrentBranchImpl(params.config.review.repoRoot);
  if (!passesBranchConditions(currentBranch, schedule.conditions?.branch)) {
    logInfo(`Schedule conditions blocked run on branch ${currentBranch}.`);
    return;
  }

  for (const commandId of commandIds) {
    const command = registry.get(commandId);
    if (!command) {
      logInfo(`[warn] Unknown command id in schedule.runs: ${commandId}`);
      continue;
    }
    const commentType = command.comment?.type ?? params.config.outputCommentType;
    await runCommandImpl({
      mode: "schedule",
      command,
      config: params.config.review,
      commentType,
      allowlist: params.config.toolsAllowlist,
      commandArgs: { args: "", argv: [] },
      logDebug,
      writeScope: schedule.writeScope,
    });
  }

  const changedFiles = await listChangedFilesImpl(params.config.review.repoRoot);
  if (changedFiles.length === 0) {
    logInfo("No changes detected after scheduled commands.");
    return;
  }

  if (!passesPathConditions(changedFiles, schedule.conditions?.paths)) {
    logInfo("Schedule conditions blocked run due to path filters.");
    return;
  }

  const diffStats = await getDiffStatsImpl(params.config.review.repoRoot);
  if (schedule.limits?.maxFiles && changedFiles.length > schedule.limits.maxFiles) {
    logInfo(`Scheduled run exceeded maxFiles (${changedFiles.length}/${schedule.limits.maxFiles}). Skipping PR.`);
    return;
  }
  if (schedule.limits?.maxDiffLines && diffStats.totalLines > schedule.limits.maxDiffLines) {
    logInfo(
      `Scheduled run exceeded maxDiffLines (${diffStats.totalLines}/${schedule.limits.maxDiffLines}). Skipping PR.`
    );
    return;
  }

  const blocked = listBlockedPaths(changedFiles, schedule.writeScope);
  if (blocked.length > 0) {
    throw new Error(`Write scope violation. Blocked paths: ${blocked.join(", ")}`);
  }

  const prConfig = schedule.pr;
  if (!prConfig) {
    throw new Error("Missing schedule.pr configuration required for scheduled PR creation.");
  }

  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;
  const branchName = buildScheduleBranchName(jobId, commandIds);

  await runGitImpl(params.config.review.repoRoot, ["checkout", "-B", branchName]);
  await runGitImpl(params.config.review.repoRoot, ["config", "user.name", "shitty-reviewing-agent"]);
  await runGitImpl(params.config.review.repoRoot, ["config", "user.email", "shitty-reviewing-agent@users.noreply.github.com"]);
  await runGitImpl(params.config.review.repoRoot, ["add", "-A"]);
  await runGitImpl(params.config.review.repoRoot, ["commit", "-m", prConfig.title]);
  await runGitImpl(params.config.review.repoRoot, ["push", "--force-with-lease", "origin", branchName]);

  const existing = await params.octokit.rest.pulls.list({
    owner,
    repo,
    state: "open",
    head: `${owner}:${branchName}`,
    base: prConfig.base,
  });

  if (existing.data.length > 0) {
    const pr = existing.data[0];
    await params.octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: pr.number,
      title: prConfig.title,
      body: prConfig.body ?? pr.body ?? "",
    });
    logInfo(`Updated existing scheduled PR #${pr.number}.`);
    return;
  }

  const created = await params.octokit.rest.pulls.create({
    owner,
    repo,
    head: branchName,
    base: prConfig.base,
    title: prConfig.title,
    body: prConfig.body ?? "",
  });
  logInfo(`Created scheduled PR #${created.data.number}.`);
}

async function listChangedFiles(repoRoot: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: repoRoot });
  const lines = stdout.toString().trim().split(/\r?\n/).filter(Boolean);
  const files: string[] = [];
  for (const line of lines) {
    const entry = line.slice(3).trim();
    if (!entry) continue;
    if (entry.includes(" -> ")) {
      const parts = entry.split(" -> ").map((part) => part.trim());
      files.push(parts[1] ?? parts[0]);
    } else {
      files.push(entry);
    }
  }
  return files;
}

async function getCurrentBranch(repoRoot: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot });
  return stdout.toString().trim();
}

async function getDiffStats(repoRoot: string): Promise<DiffStats> {
  const { stdout } = await execFileAsync("git", ["diff", "--numstat"], { cwd: repoRoot });
  const lines = stdout.toString().trim().split(/\r?\n/).filter(Boolean);
  let total = 0;
  for (const line of lines) {
    const [addedRaw, deletedRaw] = line.split(/\s+/);
    const added = parseNumstatValue(addedRaw);
    const deleted = parseNumstatValue(deletedRaw);
    total += added + deleted;
  }
  return { totalLines: total };
}

function parseNumstatValue(value: string | undefined): number {
  if (!value || value === "-") return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function passesBranchConditions(branch: string, conditions?: IncludeExclude): boolean {
  if (!conditions) return true;
  const include = conditions.include ?? [];
  const exclude = conditions.exclude ?? [];
  if (include.length > 0 && !include.some((pattern) => minimatch(branch, pattern))) {
    return false;
  }
  if (exclude.length > 0 && exclude.some((pattern) => minimatch(branch, pattern))) {
    return false;
  }
  return true;
}

function passesPathConditions(paths: string[], conditions?: IncludeExclude): boolean {
  if (!conditions) return true;
  const include = conditions.include ?? [];
  const exclude = conditions.exclude ?? [];
  let filtered = paths;
  if (include.length > 0) {
    filtered = filtered.filter((file) => include.some((pattern) => minimatch(file, pattern)));
  }
  if (exclude.length > 0) {
    filtered = filtered.filter((file) => !exclude.some((pattern) => minimatch(file, pattern)));
  }
  return filtered.length > 0;
}

export function buildScheduleBranchName(jobId: string, commandIds: string[]): string {
  const seed = commandIds.length === 1 ? commandIds[0] : `${jobId}-${commandIds.join(",")}`;
  const slug = seed
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-/g, "")
    .slice(0, 32) || "scheduled";
  const hash = crypto.createHash("sha1").update(seed).digest("hex").slice(0, 8);
  return `sra/schedule/${slug}-${hash}`;
}

async function runGit(repoRoot: string, args: string[]): Promise<void> {
  try {
    await execFileAsync("git", args, { cwd: repoRoot });
  } catch (error: any) {
    const message = error?.stderr?.toString() || error?.message || String(error);
    throw new Error(`git ${args.join(" ")} failed: ${message}`);
  }
}

interface DiffStats {
  totalLines: number;
}
