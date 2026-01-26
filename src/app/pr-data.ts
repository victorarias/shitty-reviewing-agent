import type * as github from "@actions/github";
import { listReviewThreads } from "../github-api.js";
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
  const [issueComments, reviewComments, reviewThreads] = await Promise.all([
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
    listReviewThreads(octokit, {
      owner: context.owner,
      repo: context.repo,
      pull_number: context.prNumber,
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

  const normalizedThreads: ReviewThreadInfo[] = reviewThreads.map((thread: any) => {
    const comments = Array.isArray(thread.comments) ? thread.comments : [];
    const normalized = comments.map((comment: any) => ({
      id: comment.id,
      author: comment.user?.login ?? "unknown",
      body: comment.body ?? "",
      createdAt: comment.created_at ?? "",
      updatedAt: comment.updated_at ?? comment.created_at ?? "",
      url: comment.html_url ?? "",
      side: comment.side ?? comment.start_side ?? undefined,
    }));
    const lastUpdatedAt =
      [...normalized]
        .map((item) => item.updatedAt)
        .sort((a, b) => b.localeCompare(a))[0] ?? "";
    const lastComment = [...normalized].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const rootComment = normalized[0];
    const side = (thread.side ?? thread.start_side ?? rootComment?.side) as "LEFT" | "RIGHT" | undefined;
    return {
      id: thread.id,
      path: thread.path ?? comments[0]?.path ?? "",
      line: thread.line ?? comments[0]?.line ?? null,
      side,
      isOutdated: thread.is_outdated ?? false,
      resolved: thread.resolved ?? false,
      lastUpdatedAt,
      lastActor: lastComment?.author ?? "unknown",
      rootCommentId: rootComment?.id ?? null,
      url: rootComment?.url ?? lastComment?.url ?? "",
    };
  });

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
