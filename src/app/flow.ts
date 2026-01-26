import type { ChangedFile, ExistingComment, PullRequestInfo, ReviewConfig, ReviewContext, ReviewThreadInfo } from "../types.js";
import type * as github from "@actions/github";
import { fetchChangesSinceReview, fetchExistingComments, fetchPrData } from "./pr-data.js";
import { findLastReviewedSha, findLastSummary } from "./last-review.js";
import { applyIgnorePatterns } from "./ignore.js";
import { postSkipSummary } from "./summary.js";
import { runReview } from "../agent.js";

export async function runActionFlow(params: {
  config: ReviewConfig;
  context: ReviewContext;
  octokit: ReturnType<typeof github.getOctokit>;
  logDebug?: (message: string) => void;
  fetchPrDataFn?: typeof fetchPrData;
  fetchExistingCommentsFn?: typeof fetchExistingComments;
  fetchChangesSinceReviewFn?: typeof fetchChangesSinceReview;
  runReviewFn?: typeof runReview;
  postSkipSummaryFn?: typeof postSkipSummary;
}): Promise<void> {
  const { config, context, octokit } = params;
  const fetchPrDataImpl = params.fetchPrDataFn ?? fetchPrData;
  const fetchExistingCommentsImpl = params.fetchExistingCommentsFn ?? fetchExistingComments;
  const fetchChangesSinceReviewImpl = params.fetchChangesSinceReviewFn ?? fetchChangesSinceReview;
  const runReviewImpl = params.runReviewFn ?? runReview;
  const postSkipSummaryImpl = params.postSkipSummaryFn ?? postSkipSummary;

  const { prInfo, changedFiles } = await fetchPrDataImpl(octokit, context);
  const { existingComments, reviewThreads } = await fetchExistingCommentsImpl(octokit, context);
  const lastReviewedSha = findLastReviewedSha(existingComments);
  const lastSummary = findLastSummary(existingComments);
  const scopedResult = lastReviewedSha
    ? await fetchChangesSinceReviewImpl(octokit, context, lastReviewedSha, prInfo.headSha, changedFiles)
    : { files: changedFiles, warning: null };

  if (config.debug && params.logDebug) {
    params.logDebug(`[debug] PR #${prInfo.number} ${prInfo.title}`);
    params.logDebug(`[debug] Files in PR: ${changedFiles.length}`);
    if (lastReviewedSha) {
      params.logDebug(`[debug] Last reviewed SHA: ${lastReviewedSha}`);
      params.logDebug(`[debug] Files since last review: ${scopedResult.files.length}`);
    }
    params.logDebug(`[debug] Existing comments: ${existingComments.length}`);
  }

  const filtered = applyIgnorePatterns(scopedResult.files, config.ignorePatterns);
  if (filtered.length > config.maxFiles) {
    await postSkipSummaryImpl(octokit, context, config.modelId, filtered.length, config.maxFiles);
    return;
  }

  await runReviewImpl({
    config,
    context,
    octokit,
    prInfo,
    changedFiles: filtered,
    existingComments,
    reviewThreads,
    lastReviewedSha,
    scopeWarning: scopedResult.warning ?? null,
    previousVerdict: lastSummary?.verdict ?? null,
    previousReviewUrl: lastSummary?.url ?? null,
    previousReviewAt: lastSummary?.updatedAt ?? null,
    previousReviewBody: lastSummary?.body ?? null,
  });
}

export type { ChangedFile, ExistingComment, PullRequestInfo, ReviewThreadInfo };
