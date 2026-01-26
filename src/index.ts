import * as core from "@actions/core";
import * as github from "@actions/github";
import { readConfig } from "./app/config.js";
import { readContext } from "./app/context.js";
import { resolveGithubAuth } from "./app/github-auth.js";
import { runActionFlow } from "./app/flow.js";
import type { ChangedFile, ExistingComment, PullRequestInfo, ReviewConfig, ReviewContext, ReviewThreadInfo } from "./types.js";

async function main(): Promise<void> {
  try {
    const config = readConfig();
    const context = readContext();
    const { token, authType } = await resolveGithubAuth();
    const octokit = github.getOctokit(token);
    if (config.debug) {
      core.info(`[debug] GitHub auth: ${authType}`);
    }
    await runActionFlow({ config, context, octokit, logDebug: core.info });
  } catch (error: any) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

export { buildSummaryMarkdown } from "./summary.js";

main();

export type { ChangedFile, ExistingComment, PullRequestInfo, ReviewConfig, ReviewContext, ReviewThreadInfo };
