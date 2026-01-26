import type * as github from "@actions/github";
import { fetchReviewThreadsGraphQL, normalizeReviewThreadsGraphQL } from "../github-api.js";
import { buildThreadsFromReviewComments } from "../review-threads.js";
import type { ChangedFile, ExistingComment, PullRequestInfo, ReviewContext, ReviewThreadInfo } from "../types.js";

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
    body: comment.body ?? "",
    url: comment.html_url ?? "",
    type: "issue" as const,
    updatedAt: comment.updated_at ?? comment.created_at ?? "",
  }));

  const normalizedReview = reviewComments.map((comment: any) => ({
    id: comment.id,
    author: comment.user?.login ?? "unknown",
    body: comment.body ?? "",
    url: comment.html_url ?? "",
    type: "review" as const,
    path: comment.path ?? undefined,
    line: comment.line ?? undefined,
    side: comment.side ?? undefined,
    inReplyToId: comment.in_reply_to_id ?? undefined,
    updatedAt: comment.updated_at ?? comment.created_at ?? "",
  }));

  let normalizedThreads: ReviewThreadInfo[] = [];
  try {
    const threads = await fetchReviewThreadsGraphQL(octokit, {
      owner: context.owner,
      repo: context.repo,
      pull_number: context.prNumber,
    });
    normalizedThreads = normalizeReviewThreadsGraphQL(threads);
  } catch (error: any) {
    console.warn(
      `[warn] Unable to fetch review threads via GraphQL for ${context.owner}/${context.repo}#${context.prNumber}: ${error?.message ?? error}`
    );
  }

  const existingComments = [...normalizedIssue, ...normalizedReview];
  const fallbackThreads = normalizedThreads.length === 0
    ? buildThreadsFromReviewComments(existingComments)
    : normalizedThreads;

  return { existingComments, reviewThreads: fallbackThreads };
}

export async function fetchChangesSinceReview(
  octokit: ReturnType<typeof github.getOctokit>,
  context: ReviewContext,
  baseSha: string,
  headSha: string,
  fallbackFiles: ChangedFile[]
): Promise<{ files: ChangedFile[]; warning: string | null }> {
  if (baseSha === headSha) {
    return { files: [], warning: null };
  }
  try {
    const comparison = await octokit.rest.repos.compareCommits({
      owner: context.owner,
      repo: context.repo,
      base: baseSha,
      head: headSha,
    });
    const files = comparison.data.files ?? [];
    return {
      files: files.map((file: any) => ({
        filename: file.filename,
        status: file.status as ChangedFile["status"],
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
        changes: file.changes ?? 0,
        patch: file.patch,
        previous_filename: file.previous_filename,
      })),
      warning: null,
    };
  } catch (error: any) {
    const status = error?.status ?? error?.response?.status;
    if (status === 404) {
      return {
        files: fallbackFiles,
        warning:
          "Previous review SHA no longer exists (likely force-push/rebase). Falling back to full PR review.",
      };
    }
    throw error;
  }
}
