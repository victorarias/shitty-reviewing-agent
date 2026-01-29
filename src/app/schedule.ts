import * as github from "@actions/github";
import { minimatch } from "minimatch";
import type { ActionConfig, IncludeExclude } from "../types.js";
import { CommandRegistry } from "../commands/registry.js";
import { runCommand } from "../commands/run.js";
import { getCurrentBranch } from "./schedule-utils.js";

export async function runScheduledFlow(params: {
  config: ActionConfig;
  octokit: ReturnType<typeof github.getOctokit>;
  commandRegistry?: CommandRegistry;
  runCommandFn?: typeof runCommand;
  logInfo?: (message: string) => void;
  logDebug?: (message: string) => void;
  getCurrentBranchFn?: (repoRoot: string) => Promise<string>;
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
  const getCurrentBranchImpl = params.getCurrentBranchFn ?? getCurrentBranch;

  const currentBranch = await getCurrentBranchImpl(params.config.review.repoRoot);
  if (!passesBranchConditions(currentBranch, schedule.conditions?.branch)) {
    logInfo(`Schedule conditions blocked run on branch ${currentBranch}.`);
    return;
  }

  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;

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
      schedule,
      scheduleContext: {
        jobId,
        commandIds,
        owner,
        repo,
        octokit: params.octokit,
        runGitFn: params.runGitFn,
      },
      commentType,
      allowlist: params.config.toolsAllowlist,
      commandArgs: { args: "", argv: [] },
      logDebug,
      writeScope: schedule.writeScope,
    });
  }
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
