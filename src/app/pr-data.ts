import type * as github from "@actions/github";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchReviewThreadsGraphQL, normalizeReviewThreadsGraphQL } from "../github-api.js";
import type { ChangedFile, ExistingComment, PullRequestInfo, ReviewContext, ReviewThreadInfo } from "../types.js";

const execFileAsync = promisify(execFile);

export const REVIEW_SCOPE_DECISIONS = {
  REVIEW: "review",
  SKIP_CONFIDENT: "skip_confident",
} as const;

export type ReviewScopeDecision = typeof REVIEW_SCOPE_DECISIONS[keyof typeof REVIEW_SCOPE_DECISIONS];

export const REVIEW_SCOPE_REASON_CODES = {
  NO_PREVIOUS_REVIEW_SHA_REVIEW_FULL_PR: "NO_PREVIOUS_REVIEW_SHA_REVIEW_FULL_PR",
  BASE_EQUALS_HEAD_SKIP: "BASE_EQUALS_HEAD_SKIP",
  LOCAL_TWO_DOT_NO_PR_FILE_CHANGES_SKIP: "LOCAL_TWO_DOT_NO_PR_FILE_CHANGES_SKIP",
  LOCAL_TWO_DOT_PR_FILE_CHANGES_REVIEW: "LOCAL_TWO_DOT_PR_FILE_CHANGES_REVIEW",
  COMPARE_404_REVIEW_FULL_PR: "COMPARE_404_REVIEW_FULL_PR",
  COMPARE_EMPTY_REVIEW_FULL_PR: "COMPARE_EMPTY_REVIEW_FULL_PR",
  COMPARE_TRUNCATED_REVIEW_FULL_PR: "COMPARE_TRUNCATED_REVIEW_FULL_PR",
  DIVERGED_SCOPED_REVIEW: "DIVERGED_SCOPED_REVIEW",
  SCOPED_REVIEW: "SCOPED_REVIEW",
  NO_COMPARE_OVERLAP_REVIEW_FULL_PR: "NO_COMPARE_OVERLAP_REVIEW_FULL_PR",
} as const;

export type ReviewScopeReasonCode = typeof REVIEW_SCOPE_REASON_CODES[keyof typeof REVIEW_SCOPE_REASON_CODES];

export interface ChangesSinceReviewResult {
  files: ChangedFile[];
  warning: string | null;
  decision: ReviewScopeDecision;
  reasonCode: ReviewScopeReasonCode;
  reason: string;
}

export async function fetchPrData(
  octokit: ReturnType<typeof github.getOctokit>,
  context: ReviewContext
): Promise<{ prInfo: PullRequestInfo; changedFiles: ChangedFile[] }> {
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

  const changedFiles: ChangedFile[] = files.map((file: any) => ({
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

export async function fetchExistingComments(
  octokit: ReturnType<typeof github.getOctokit>,
  context: ReviewContext
): Promise<{ existingComments: ExistingComment[]; reviewThreads: ReviewThreadInfo[] }> {
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

  const normalizedIssue = issueComments.map((comment: any) => ({
    id: comment.id,
    author: comment.user?.login ?? "unknown",
    authorType: comment.user?.type ?? undefined,
    authorAssociation: comment.author_association ?? undefined,
    body: comment.body ?? "",
    url: comment.html_url ?? "",
    type: "issue" as const,
    updatedAt: comment.updated_at ?? comment.created_at ?? "",
  }));

  const normalizedReview = reviewComments.map((comment: any) => ({
    id: comment.id,
    author: comment.user?.login ?? "unknown",
    authorType: comment.user?.type ?? undefined,
    authorAssociation: comment.author_association ?? undefined,
    body: comment.body ?? "",
    url: comment.html_url ?? "",
    type: "review" as const,
    path: comment.path ?? undefined,
    line: comment.line ?? undefined,
    side: comment.side ?? undefined,
    inReplyToId: comment.in_reply_to_id ?? undefined,
    updatedAt: comment.updated_at ?? comment.created_at ?? "",
  }));

  const threads = await fetchReviewThreadsGraphQL(octokit, {
    owner: context.owner,
    repo: context.repo,
    pull_number: context.prNumber,
  });
  const normalizedThreads = normalizeReviewThreadsGraphQL(threads);

  const existingComments = [...normalizedIssue, ...normalizedReview];
  return { existingComments, reviewThreads: normalizedThreads };
}

export async function fetchChangesSinceReview(
  octokit: ReturnType<typeof github.getOctokit>,
  context: ReviewContext,
  baseSha: string,
  headSha: string,
  fallbackFiles: ChangedFile[],
  options?: { repoRoot?: string }
): Promise<ChangesSinceReviewResult> {
  if (baseSha === headSha) {
    return {
      files: [],
      warning: null,
      decision: REVIEW_SCOPE_DECISIONS.SKIP_CONFIDENT,
      reasonCode: REVIEW_SCOPE_REASON_CODES.BASE_EQUALS_HEAD_SKIP,
      reason: "Current head SHA matches last reviewed SHA. Skipping review run.",
    };
  }
  try {
    const comparison = await octokit.rest.repos.compareCommits({
      owner: context.owner,
      repo: context.repo,
      base: baseSha,
      head: headSha,
    });
    const files = comparison.data.files ?? [];
    if (files.length === 0) {
      return {
        files: fallbackFiles,
        warning:
          "GitHub compare returned zero files for differing SHAs. Falling back to full PR diff to avoid missing changes.",
        decision: REVIEW_SCOPE_DECISIONS.REVIEW,
        reasonCode: REVIEW_SCOPE_REASON_CODES.COMPARE_EMPTY_REVIEW_FULL_PR,
        reason: "Compare returned zero files for differing SHAs; reviewing full PR diff for safety.",
      };
    }
    if (files.length >= 300) {
      return {
        files: fallbackFiles,
        warning:
          "GitHub compare returned 300+ files and may be truncated. Falling back to full PR diff to avoid missing changes.",
        decision: REVIEW_SCOPE_DECISIONS.REVIEW,
        reasonCode: REVIEW_SCOPE_REASON_CODES.COMPARE_TRUNCATED_REVIEW_FULL_PR,
        reason: "Compare may be truncated at file limits; reviewing full PR diff for safety.",
      };
    }

    const localScopedFiles = await getLocalPrFilesChangedSinceReview(
      options?.repoRoot,
      baseSha,
      headSha,
      fallbackFiles
    );
    if (localScopedFiles) {
      if (localScopedFiles.length === 0) {
        const status = comparison.data.status ?? "";
        const aheadBy = comparison.data.ahead_by ?? 0;
        const behindBy = comparison.data.behind_by ?? 0;
        const rangeInfo = status ? `status=${status}, ahead_by=${aheadBy}, behind_by=${behindBy}` : "";
        return {
          files: [],
          warning:
            "Local git verification found no PR-authored file changes between last reviewed SHA and current head. Treating as rebase/merge-only update.",
          decision: REVIEW_SCOPE_DECISIONS.SKIP_CONFIDENT,
          reasonCode: REVIEW_SCOPE_REASON_CODES.LOCAL_TWO_DOT_NO_PR_FILE_CHANGES_SKIP,
          reason: rangeInfo
            ? `No PR-authored file changes between last review and current head (${rangeInfo}).`
            : "No PR-authored file changes between last review and current head.",
        };
      }
      return {
        files: localScopedFiles,
        warning: null,
        decision: REVIEW_SCOPE_DECISIONS.REVIEW,
        reasonCode: REVIEW_SCOPE_REASON_CODES.LOCAL_TWO_DOT_PR_FILE_CHANGES_REVIEW,
        reason: `Detected ${localScopedFiles.length} PR-authored file(s) changed since last review via local git verification.`,
      };
    }

    const comparedPaths = new Set<string>();
    for (const file of files) {
      if (file.filename) comparedPaths.add(file.filename);
      if (file.previous_filename) comparedPaths.add(file.previous_filename);
    }

    const scopedFiles = fallbackFiles.filter((file) => {
      if (comparedPaths.has(file.filename)) return true;
      if (file.previous_filename && comparedPaths.has(file.previous_filename)) return true;
      return false;
    });

    const status = comparison.data.status ?? "";
    const behindBy = comparison.data.behind_by ?? 0;
    const historyDiverged = status === "diverged" || status === "behind" || behindBy > 0;

    if (scopedFiles.length === 0) {
      return {
        files: fallbackFiles,
        warning:
          "Unable to confidently isolate incremental PR file changes from compare output. Falling back to full PR diff to avoid missing issues.",
        decision: REVIEW_SCOPE_DECISIONS.REVIEW,
        reasonCode: REVIEW_SCOPE_REASON_CODES.NO_COMPARE_OVERLAP_REVIEW_FULL_PR,
        reason: "No overlap between compare files and current PR files; reviewing full PR diff for safety.",
      };
    }

    if (historyDiverged) {
      return {
        files: scopedFiles,
        warning:
          "Previous review SHA diverged from current history (likely force-push/rebase/merge). Scoped to current PR diff to avoid reviewing pulled-in base branch changes.",
        decision: REVIEW_SCOPE_DECISIONS.REVIEW,
        reasonCode: REVIEW_SCOPE_REASON_CODES.DIVERGED_SCOPED_REVIEW,
        reason: "Compare history diverged; reviewing scoped PR files only.",
      };
    }

    return {
      files: scopedFiles,
      warning: null,
      decision: REVIEW_SCOPE_DECISIONS.REVIEW,
      reasonCode: REVIEW_SCOPE_REASON_CODES.SCOPED_REVIEW,
      reason: "Reviewing scoped PR files since last review.",
    };
  } catch (error: any) {
    const status = error?.status ?? error?.response?.status;
    if (status === 404) {
      return {
        files: fallbackFiles,
        warning:
          "Previous review SHA no longer exists (likely force-push/rebase). Falling back to full PR review.",
        decision: REVIEW_SCOPE_DECISIONS.REVIEW,
        reasonCode: REVIEW_SCOPE_REASON_CODES.COMPARE_404_REVIEW_FULL_PR,
        reason: "Last reviewed SHA was not found; reviewing full PR diff for safety.",
      };
    }
    throw error;
  }
}

async function getLocalPrFilesChangedSinceReview(
  repoRoot: string | undefined,
  baseSha: string,
  headSha: string,
  fallbackFiles: ChangedFile[]
): Promise<ChangedFile[] | null> {
  if (!repoRoot) return null;
  if (!(await hasCommit(repoRoot, baseSha))) return null;
  if (!(await hasCommit(repoRoot, headSha))) return null;

  const { stdout } = await execFileAsync("git", ["diff", "--name-only", `${baseSha}..${headSha}`], {
    cwd: repoRoot,
  });
  const changedPaths = new Set(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  );
  return fallbackFiles.filter((file) => {
    if (changedPaths.has(file.filename)) return true;
    if (file.previous_filename && changedPaths.has(file.previous_filename)) return true;
    return false;
  });
}

async function hasCommit(repoRoot: string, sha: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: repoRoot });
    return true;
  } catch (_error) {
    return false;
  }
}
