import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { getOctokit } from "@actions/github";
import { minimatch } from "minimatch";
import type { IncludeExclude, ScheduleConfig } from "../types.js";
import { buildScheduleBranchName } from "../app/schedule-utils.js";
import { listBlockedPaths } from "../app/write-scope.js";

const execFileAsync = promisify(execFile);

type Octokit = ReturnType<typeof getOctokit>;

interface SchedulePrDeps {
  repoRoot: string;
  schedule?: ScheduleConfig;
  writeScope?: IncludeExclude;
  jobId: string;
  commandIds: string[];
  owner: string;
  repo: string;
  octokit: Octokit;
  runGit?: (repoRoot: string, args: string[]) => Promise<void>;
}

export function createSchedulePrTools(deps: SchedulePrDeps): AgentTool<any>[] {
  const schedule = deps.schedule ?? {};
  const state = {
    branch: buildScheduleBranchName(deps.jobId, deps.commandIds),
  };

  const commitTool: AgentTool<typeof CommitSchema, { branch: string }> = {
    name: "commit_changes",
    label: "Commit changes",
    description: "Stage and commit the current workspace changes to a branch.",
    parameters: CommitSchema,
    execute: async (_id, params) => {
      const branch = resolveBranch(params.branch, state.branch);
      const changedFiles = await listWorkingTreeFiles(deps.repoRoot);
      if (changedFiles.length === 0) {
        throw new Error("No changes detected. Make edits before committing.");
      }
      const blocked = listBlockedPaths(changedFiles, deps.writeScope);
      if (blocked.length > 0) {
        throw new Error(`Write scope violation. Blocked paths: ${blocked.join(", ")}`);
      }
      await runGit(deps, ["checkout", "-B", branch]);
      await runGit(deps, ["config", "user.name", "shitty-reviewing-agent"]);
      await runGit(deps, ["config", "user.email", "shitty-reviewing-agent@users.noreply.github.com"]);
      await runGit(deps, ["add", "-A"]);
      await runGit(deps, ["commit", "-m", params.message]);
      state.branch = branch;
      return {
        content: [{ type: "text", text: `Committed changes on ${branch}.` }],
        details: { branch },
      };
    },
  };

  const pushTool: AgentTool<typeof PushPrSchema, { branch: string }> = {
    name: "push_pr",
    label: "Push PR",
    description: "Push the committed branch and open or update a pull request.",
    parameters: PushPrSchema,
    execute: async (_id, params) => {
      const branch = resolveBranch(params.branch, state.branch);
      await assertCleanWorkingTree(deps.repoRoot);
      await assertBranchExists(deps.repoRoot, branch);

      const baseBranch = await getDefaultBranch(deps.octokit, deps.owner, deps.repo);
      const baseRef = await resolveBaseRef(deps.repoRoot, baseBranch);
      if (branch === baseBranch) {
        throw new Error(`Refusing to push PR from base branch (${baseBranch}).`);
      }

      const changedFiles = await listDiffFiles(deps.repoRoot, baseRef);
      if (changedFiles.length === 0) {
        throw new Error("No committed changes found to submit.");
      }

      if (schedule.conditions?.paths && !passesPathConditions(changedFiles, schedule.conditions.paths)) {
        throw new Error("Schedule conditions blocked PR creation due to path filters.");
      }

      const diffStats = await getDiffStats(deps.repoRoot, baseRef);
      if (schedule.limits?.maxFiles && changedFiles.length > schedule.limits.maxFiles) {
        throw new Error(
          `Scheduled run exceeded maxFiles (${changedFiles.length}/${schedule.limits.maxFiles}).`
        );
      }
      if (schedule.limits?.maxDiffLines && diffStats.totalLines > schedule.limits.maxDiffLines) {
        throw new Error(
          `Scheduled run exceeded maxDiffLines (${diffStats.totalLines}/${schedule.limits.maxDiffLines}).`
        );
      }

      const blocked = listBlockedPaths(changedFiles, deps.writeScope);
      if (blocked.length > 0) {
        throw new Error(`Write scope violation. Blocked paths: ${blocked.join(", ")}`);
      }

      await runGit(deps, ["push", "--force-with-lease", "origin", branch]);

      const existing = await deps.octokit.rest.pulls.list({
        owner: deps.owner,
        repo: deps.repo,
        state: "open",
        head: `${deps.owner}:${branch}`,
        base: baseBranch,
      });

      const body = params.body ?? "";
      if (existing.data.length > 0) {
        const pr = existing.data[0];
        await deps.octokit.rest.pulls.update({
          owner: deps.owner,
          repo: deps.repo,
          pull_number: pr.number,
          title: params.title,
          body,
        });
        return {
          content: [{ type: "text", text: `Updated existing PR #${pr.number}.` }],
          details: { branch },
        };
      }

      const created = await deps.octokit.rest.pulls.create({
        owner: deps.owner,
        repo: deps.repo,
        head: branch,
        base: baseBranch,
        title: params.title,
        body,
        draft: params.draft ?? false,
      });

      return {
        content: [{ type: "text", text: `Created PR #${created.data.number}.` }],
        details: { branch },
      };
    },
  };

  return [commitTool, pushTool];
}

async function runGit(deps: SchedulePrDeps, args: string[]): Promise<void> {
  if (deps.runGit) {
    await deps.runGit(deps.repoRoot, args);
    return;
  }
  await execFileAsync("git", args, { cwd: deps.repoRoot });
}

async function listWorkingTreeFiles(repoRoot: string): Promise<string[]> {
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

async function listDiffFiles(repoRoot: string, baseRef: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["diff", "--name-only", `${baseRef}...HEAD`], { cwd: repoRoot });
  return stdout
    .toString()
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function assertCleanWorkingTree(repoRoot: string): Promise<void> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: repoRoot });
  if (stdout.toString().trim()) {
    throw new Error("Working tree has uncommitted changes. Commit before pushing a PR.");
  }
}

async function assertBranchExists(repoRoot: string, branch: string): Promise<void> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", branch], { cwd: repoRoot });
  } catch {
    throw new Error(`Branch ${branch} does not exist. Commit changes first.`);
  }
}

async function resolveBaseRef(repoRoot: string, baseBranch: string): Promise<string> {
  if (await refExists(repoRoot, baseBranch)) return baseBranch;
  const remoteRef = `refs/remotes/origin/${baseBranch}`;
  if (await refExists(repoRoot, remoteRef)) return remoteRef;
  try {
    await execFileAsync("git", ["fetch", "origin", `${baseBranch}:${remoteRef}`], { cwd: repoRoot });
  } catch {
    // Ignore fetch failures; we'll fall through to ref checks.
  }
  if (await refExists(repoRoot, remoteRef)) return remoteRef;
  if (await refExists(repoRoot, baseBranch)) return baseBranch;
  throw new Error(`Base branch ${baseBranch} not found locally; ensure the branch is fetched.`);
}

async function refExists(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", ref], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

async function getDefaultBranch(octokit: Octokit, owner: string, repo: string): Promise<string> {
  try {
    const response = await octokit.rest.repos.get({ owner, repo });
    const branch = response.data.default_branch?.trim();
    return branch || "main";
  } catch {
    return "main";
  }
}

async function getDiffStats(repoRoot: string, baseRef: string): Promise<{ totalLines: number }> {
  const { stdout } = await execFileAsync("git", ["diff", "--numstat", `${baseRef}...HEAD`], { cwd: repoRoot });
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

function resolveBranch(input: string | undefined, fallback: string): string {
  const branch = (input ?? fallback).trim();
  if (!branch) {
    throw new Error("Branch name is required.");
  }
  return branch;
}

const CommitSchema = Type.Object({
  message: Type.String({ description: "Commit message" }),
  branch: Type.Optional(Type.String({ description: "Branch name (optional; defaults to schedule branch)" })),
});

const PushPrSchema = Type.Object({
  title: Type.String({ description: "PR title" }),
  body: Type.Optional(Type.String({ description: "PR body" })),
  branch: Type.Optional(Type.String({ description: "Branch name (optional; defaults to schedule branch)" })),
  draft: Type.Optional(Type.Boolean({ description: "Create a draft PR" })),
});
