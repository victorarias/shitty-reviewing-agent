import * as core from "@actions/core";
import * as github from "@actions/github";
import { readConfig } from "./app/config.js";
import { readContext } from "./app/context.js";
import { resolveRunMode, shouldHandleIssueComment } from "./app/mode.js";
import { resolveGithubAuth } from "./app/github-auth.js";
import { runActionFlow } from "./app/flow.js";
import { fetchExistingComments, fetchPrData } from "./app/pr-data.js";
import { parseCommandInvocation } from "./commands/args.js";
import { CommandRegistry } from "./commands/registry.js";
import { runCommand } from "./commands/run.js";
import type { ChangedFile, ExistingComment, PullRequestInfo, ReviewConfig, ReviewContext, ReviewThreadInfo } from "./types.js";

async function main(): Promise<void> {
  try {
    const actionConfig = readConfig();
    const { token, authType } = await resolveGithubAuth();
    const octokit = github.getOctokit(token);
    if (actionConfig.review.debug) {
      core.info(`[debug] GitHub auth: ${authType}`);
    }
    const registry = new CommandRegistry(actionConfig.commands);
    const mode = resolveRunMode();
    if (mode.mode === "pull_request") {
      const context = readContext(mode.prNumber);
      await runActionFlow({
        config: actionConfig,
        context,
        octokit,
        logDebug: core.info,
        commandIds: actionConfig.reviewRun,
        commandRegistry: registry,
        runCommandFn: runCommand,
        toolsAllowlist: actionConfig.toolsAllowlist,
        defaultCommentType: actionConfig.outputCommentType,
        logInfo: core.info,
      });
      return;
    }
    if (mode.mode === "issue_comment") {
      if (!shouldHandleIssueComment(mode, core.info)) return;
      const invocation = parseCommandInvocation(mode.commentBody);
      if (!invocation) return;
      const command = registry.get(invocation.command);
      if (!command) return;
      const context = readContext(mode.prNumber);
      const { prInfo, changedFiles } = await fetchPrData(octokit, context);
      const { existingComments, reviewThreads } = await fetchExistingComments(octokit, context);
      const commentType = command.comment?.type ?? actionConfig.outputCommentType;
      await runCommand({
        mode: "pr",
        command,
        config: actionConfig.review,
        context,
        octokit,
        prInfo,
        changedFiles,
        existingComments,
        reviewThreads,
        commandArgs: { args: invocation.args, argv: invocation.argv },
        commentType,
        allowlist: actionConfig.toolsAllowlist,
      });
      return;
    }
    if (mode.mode === "schedule") {
      core.info("Scheduled runs are not enabled in this version.");
      return;
    }
    core.info(`Unsupported event ${mode.eventName}. Nothing to do.`);
  } catch (error: any) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

export { buildSummaryMarkdown } from "./summary.js";

main();

export type { ChangedFile, ExistingComment, PullRequestInfo, ReviewConfig, ReviewContext, ReviewThreadInfo };
