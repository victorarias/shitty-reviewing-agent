import type * as github from "@actions/github";
import type { ReviewContext } from "../types.js";
import { buildSummaryMarkdown } from "../summary.js";

export async function postSkipSummary(
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

export async function postNoNewChangesSummary(
  octokit: ReturnType<typeof github.getOctokit>,
  context: ReviewContext,
  modelId: string,
  reviewSha: string,
  reason?: string
): Promise<void> {
  await octokit.rest.issues.createComment({
    owner: context.owner,
    repo: context.repo,
    issue_number: context.prNumber,
    body: buildSummaryMarkdown({
      verdict: "Skipped",
      issues: [reason ?? "No new PR-authored changes detected since the last review."],
      keyFindings: ["Push appears to contain only rebase/merge updates from base branch history."],
      multiFileSuggestions: ["None"],
      model: modelId,
      reviewSha,
    }),
  });
}
