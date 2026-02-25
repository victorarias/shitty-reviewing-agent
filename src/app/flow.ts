import type {
  ActionConfig,
  ChangedFile,
  CommentType,
  ExistingComment,
  PullRequestInfo,
  ReviewConfig,
  ReviewContext,
  ReviewThreadInfo,
  ToolCategory,
} from "../types.js";
import type * as github from "@actions/github";
import {
  fetchChangesSinceReview,
  fetchExistingComments,
  fetchPrData,
  REVIEW_SCOPE_DECISIONS,
  REVIEW_SCOPE_REASON_CODES,
} from "./pr-data.js";
import { findLastReviewedSha, findLastSummary } from "./last-review.js";
import { applyIgnorePatterns } from "./ignore.js";
import { postNoNewChangesSummary, postSkipSummary } from "./summary.js";
import { runReview } from "../agent.js";
import type { CommandRegistry } from "../commands/registry.js";
import { runCommand } from "../commands/command-runner.js";

export async function runActionFlow(params: {
  config: ActionConfig;
  context: ReviewContext;
  octokit: ReturnType<typeof github.getOctokit>;
  logDebug?: (message: string) => void;
  fetchPrDataFn?: typeof fetchPrData;
  fetchExistingCommentsFn?: typeof fetchExistingComments;
  fetchChangesSinceReviewFn?: typeof fetchChangesSinceReview;
  runReviewFn?: typeof runReview;
  postSkipSummaryFn?: typeof postSkipSummary;
  postNoNewChangesSummaryFn?: typeof postNoNewChangesSummary;
  commandIds?: string[];
  commandRegistry?: CommandRegistry;
  runCommandFn?: typeof runCommand;
  toolsAllowlist?: ToolCategory[];
  defaultCommentType?: CommentType;
  logInfo?: (message: string) => void;
}): Promise<void> {
  const { config, context, octokit } = params;
  const reviewConfig: ReviewConfig = config.review;
  const fetchPrDataImpl = params.fetchPrDataFn ?? fetchPrData;
  const fetchExistingCommentsImpl = params.fetchExistingCommentsFn ?? fetchExistingComments;
  const fetchChangesSinceReviewImpl = params.fetchChangesSinceReviewFn ?? fetchChangesSinceReview;
  const runReviewImpl = params.runReviewFn ?? runReview;
  const postSkipSummaryImpl = params.postSkipSummaryFn ?? postSkipSummary;
  const postNoNewChangesSummaryImpl = params.postNoNewChangesSummaryFn ?? postNoNewChangesSummary;
  const runCommandImpl = params.runCommandFn ?? runCommand;
  const logInfo = params.logInfo ?? console.info;

  const { prInfo, changedFiles } = await fetchPrDataImpl(octokit, context);
  const { existingComments, reviewThreads } = await fetchExistingCommentsImpl(octokit, context);
  const lastReviewedSha = findLastReviewedSha(existingComments);
  const lastSummary = findLastSummary(existingComments);
  const scopedResult = lastReviewedSha
    ? await fetchChangesSinceReviewImpl(octokit, context, lastReviewedSha, prInfo.headSha, changedFiles, {
      repoRoot: reviewConfig.repoRoot,
    })
    : {
      files: changedFiles,
      warning: null,
      decision: REVIEW_SCOPE_DECISIONS.REVIEW,
      reasonCode: REVIEW_SCOPE_REASON_CODES.NO_PREVIOUS_REVIEW_SHA_REVIEW_FULL_PR,
      reason: "No previous review SHA marker found. Reviewing current PR diff.",
    };

  if (reviewConfig.debug && params.logDebug) {
    params.logDebug(`[debug] PR #${prInfo.number} ${prInfo.title}`);
    params.logDebug(`[debug] Files in PR: ${changedFiles.length}`);
    if (lastReviewedSha) {
      params.logDebug(`[debug] Last reviewed SHA: ${lastReviewedSha}`);
      params.logDebug(`[debug] Files since last review: ${scopedResult.files.length}`);
      params.logDebug(`[debug] Scope decision: ${scopedResult.decision} (${scopedResult.reasonCode})`);
    }
    params.logDebug(`[debug] Existing comments: ${existingComments.length}`);
  }

  const filtered = applyIgnorePatterns(scopedResult.files, reviewConfig.ignorePatterns);
  const filteredFullPrFiles = applyIgnorePatterns(changedFiles, reviewConfig.ignorePatterns);
  logScopeShadowTelemetry({
    logInfo,
    prNumber: prInfo.number,
    lastReviewedSha,
    headSha: prInfo.headSha,
    decision: scopedResult.decision,
    reasonCode: scopedResult.reasonCode,
    scopedFilesBeforeIgnore: scopedResult.files.length,
    scopedFilesAfterIgnore: filtered.length,
    fullPrFilesAfterIgnore: filteredFullPrFiles.length,
  });
  if (scopedResult.decision === REVIEW_SCOPE_DECISIONS.SKIP_CONFIDENT) {
    await postNoNewChangesSummaryImpl(
      octokit,
      context,
      reviewConfig.modelId,
      prInfo.headSha,
      scopedResult.reason
    );
    return;
  }
  if (filtered.length > reviewConfig.maxFiles) {
    await postSkipSummaryImpl(octokit, context, reviewConfig.modelId, filtered.length, reviewConfig.maxFiles);
    return;
  }

  await runReviewImpl({
    config: reviewConfig,
    context,
    octokit,
    prInfo,
    changedFiles: filtered,
    fullPrChangedFiles: filteredFullPrFiles,
    existingComments,
    reviewThreads,
    lastReviewedSha,
    scopeWarning: scopedResult.warning ?? null,
    previousVerdict: lastSummary?.verdict ?? null,
    previousReviewUrl: lastSummary?.url ?? null,
    previousReviewAt: lastSummary?.updatedAt ?? null,
    previousReviewBody: lastSummary?.body ?? null,
    toolAllowlist: params.toolsAllowlist,
  });

  if (params.commandIds && params.commandIds.length > 0 && params.commandRegistry) {
    for (const commandId of params.commandIds) {
      const command = params.commandRegistry.get(commandId);
      if (!command) {
        logInfo(`[warn] Unknown command id in review.run: ${commandId}`);
        continue;
      }
      const commentType = command.comment?.type ?? params.defaultCommentType ?? "both";
      await runCommandImpl({
        mode: "pr",
        command,
        config: reviewConfig,
        context,
        octokit,
        prInfo,
        changedFiles: filtered,
        existingComments,
        reviewThreads,
        commentType,
        allowlist: params.toolsAllowlist ?? [],
      });
    }
  }
}

export type { ChangedFile, ExistingComment, PullRequestInfo, ReviewThreadInfo };

function logScopeShadowTelemetry(params: {
  logInfo: (message: string) => void;
  prNumber: number;
  lastReviewedSha: string | null;
  headSha: string;
  decision: string;
  reasonCode: string;
  scopedFilesBeforeIgnore: number;
  scopedFilesAfterIgnore: number;
  fullPrFilesAfterIgnore: number;
}): void {
  const {
    logInfo,
    prNumber,
    lastReviewedSha,
    headSha,
    decision,
    reasonCode,
    scopedFilesBeforeIgnore,
    scopedFilesAfterIgnore,
    fullPrFilesAfterIgnore,
  } = params;
  const wouldReviewFullPr = true;
  const fileDeltaVsAlwaysReview = fullPrFilesAfterIgnore - scopedFilesAfterIgnore;
  const mode = decision === REVIEW_SCOPE_DECISIONS.SKIP_CONFIDENT ? "skip" : "review";
  const hasLastReviewedSha = lastReviewedSha ? "true" : "false";
  logInfo(
    `[scope-shadow] pr=${prNumber} mode=${mode} decision=${decision} reason_code=${reasonCode} ` +
      `has_last_reviewed_sha=${hasLastReviewedSha} head_sha=${headSha} ` +
      `scoped_files_before_ignore=${scopedFilesBeforeIgnore} scoped_files_after_ignore=${scopedFilesAfterIgnore} ` +
      `always_review_full_pr=${wouldReviewFullPr} always_review_files_after_ignore=${fullPrFilesAfterIgnore} ` +
      `file_delta_vs_always_review=${fileDeltaVsAlwaysReview}`
  );
}
