import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { getOctokit } from "@actions/github";
import type { ChangedFile, ExistingComment, PullRequestInfo } from "../types.js";
import { fetchReviewThreadsGraphQL } from "../github-api.js";
import { buildThreadsFromReviewComments } from "../review-threads.js";

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

type Octokit = ReturnType<typeof getOctokit>;

interface GithubToolDeps {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  cache: {
    prInfo?: PullRequestInfo;
    changedFiles?: ChangedFile[];
    fullChangedFiles?: ChangedFile[];
    reviewContext?: ReviewContextPayload;
  };
}

export function createGithubTools(deps: GithubToolDeps): AgentTool<any>[] {
  const getPrInfo: AgentTool<typeof PrInfoSchema, PullRequestInfo> = {
    name: "get_pr_info",
    label: "Get PR info",
    description: "Get PR title, description, author, base/head branches, and SHAs.",
    parameters: PrInfoSchema,
    execute: async () => {
      if (!deps.cache.prInfo) {
        const response = await safeCall(() =>
          deps.octokit.rest.pulls.get({
            owner: deps.owner,
            repo: deps.repo,
            pull_number: deps.pullNumber,
          })
        );
        const pr = response.data;
        deps.cache.prInfo = {
          number: pr.number,
          title: pr.title ?? "",
          body: pr.body ?? "",
          author: pr.user?.login ?? "unknown",
          baseRef: pr.base?.ref ?? "",
          headRef: pr.head?.ref ?? "",
          baseSha: pr.base?.sha ?? "",
          headSha: pr.head?.sha ?? "",
          url: pr.html_url ?? "",
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(deps.cache.prInfo, null, 2) }],
        details: deps.cache.prInfo,
      };
    },
  };

  const getChangedFiles: AgentTool<typeof ChangedFilesSchema, { files: ChangedFile[] }> = {
    name: "get_changed_files",
    label: "Get changed files",
    description: "List files changed in the PR (path + status). Uses the scoped file list by default.",
    parameters: ChangedFilesSchema,
    execute: async () => {
      if (!deps.cache.changedFiles) {
        const files = await safeCall(() =>
          deps.octokit.paginate(deps.octokit.rest.pulls.listFiles, {
            owner: deps.owner,
            repo: deps.repo,
            pull_number: deps.pullNumber,
            per_page: 100,
          })
        );
        deps.cache.changedFiles = files.map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
          changes: file.changes ?? 0,
          patch: file.patch,
          previous_filename: file.previous_filename,
        }));
      }

      return {
        content: [{ type: "text", text: JSON.stringify(deps.cache.changedFiles, null, 2) }],
        details: { files: deps.cache.changedFiles },
      };
    },
  };

  const getFullChangedFiles: AgentTool<typeof ChangedFilesSchema, { files: ChangedFile[] }> = {
    name: "get_full_changed_files",
    label: "Get full changed files",
    description: "List all files changed in the PR (ignores scoped filtering).",
    parameters: ChangedFilesSchema,
    execute: async () => {
      if (!deps.cache.fullChangedFiles) {
        const files = await safeCall(() =>
          deps.octokit.paginate(deps.octokit.rest.pulls.listFiles, {
            owner: deps.owner,
            repo: deps.repo,
            pull_number: deps.pullNumber,
            per_page: 100,
          })
        );
        deps.cache.fullChangedFiles = files.map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
          changes: file.changes ?? 0,
          patch: file.patch,
          previous_filename: file.previous_filename,
        }));
      }

      return {
        content: [{ type: "text", text: JSON.stringify(deps.cache.fullChangedFiles, null, 2) }],
        details: { files: deps.cache.fullChangedFiles },
      };
    },
  };

  const getDiff: AgentTool<typeof DiffSchema, { path: string; patch?: string }> = {
    name: "get_diff",
    label: "Get diff",
    description: "Get diff for a specific file in the PR (scoped by default).",
    parameters: DiffSchema,
    execute: async (_id, params) => {
      if (!deps.cache.changedFiles) {
        const files = await safeCall(() =>
          deps.octokit.paginate(deps.octokit.rest.pulls.listFiles, {
            owner: deps.owner,
            repo: deps.repo,
            pull_number: deps.pullNumber,
            per_page: 100,
          })
        );
        deps.cache.changedFiles = files.map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
          changes: file.changes ?? 0,
          patch: file.patch,
          previous_filename: file.previous_filename,
        }));
      }

      const match = deps.cache.changedFiles.find((file) => file.filename === params.path);
      const patch = match?.patch;
      const text = patch ? patch : "(no diff available - possibly binary or too large)";
      return {
        content: [{ type: "text", text }],
        details: { path: params.path, patch },
      };
    },
  };

  const getFullDiff: AgentTool<typeof DiffSchema, { path: string; patch?: string }> = {
    name: "get_full_diff",
    label: "Get full diff",
    description: "Get diff for a specific file using the full PR file list.",
    parameters: DiffSchema,
    execute: async (_id, params) => {
      if (!deps.cache.fullChangedFiles) {
        const files = await safeCall(() =>
          deps.octokit.paginate(deps.octokit.rest.pulls.listFiles, {
            owner: deps.owner,
            repo: deps.repo,
            pull_number: deps.pullNumber,
            per_page: 100,
          })
        );
        deps.cache.fullChangedFiles = files.map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
          changes: file.changes ?? 0,
          patch: file.patch,
          previous_filename: file.previous_filename,
        }));
      }

      const match = deps.cache.fullChangedFiles.find((file) => file.filename === params.path);
      const patch = match?.patch;
      const text = patch ? patch : "(no diff available - possibly binary or too large)";
      return {
        content: [{ type: "text", text }],
        details: { path: params.path, patch },
      };
    },
  };

  const getReviewContext: AgentTool<typeof ReviewContextSchema, ReviewContextPayload> = {
    name: "get_review_context",
    label: "Get review context",
    description: "Get prior review summaries, review threads, and commits since the last review summary.",
    parameters: ReviewContextSchema,
    execute: async () => {
      if (!deps.cache.reviewContext) {
        const [comments, reviewComments] = await Promise.all([
          safeCall(() =>
            deps.octokit.paginate(deps.octokit.rest.issues.listComments, {
              owner: deps.owner,
              repo: deps.repo,
              issue_number: deps.pullNumber,
              per_page: 100,
            })
          ),
          safeCall(() =>
            deps.octokit.paginate(deps.octokit.rest.pulls.listReviewComments, {
              owner: deps.owner,
              repo: deps.repo,
              pull_number: deps.pullNumber,
              per_page: 100,
            })
          ),
        ]);

        const summaries = comments
          .filter((comment) => comment.body?.includes("Reviewed by shitty-reviewing-agent"))
          .map((comment) => ({
            id: comment.id,
            author: comment.user?.login ?? "unknown",
            createdAt: comment.created_at ?? "",
            url: comment.html_url ?? "",
            body: comment.body ?? "",
            timestamp: parseTimestamp(comment.created_at ?? ""),
          }))
          .filter((summary) => summary.timestamp !== null)
          .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
          .map(({ timestamp, ...summary }) => summary);

        const lastReviewAt = summaries.length > 0 ? summaries[0].createdAt : null;
        const lastReviewTime = parseTimestamp(lastReviewAt) ?? null;

        const normalizedReviewComments: ExistingComment[] = reviewComments.map((comment: any) => ({
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

        const fallbackThreads = buildThreadsFromReviewComments(normalizedReviewComments);
        const fallbackThreadsWithComments = fallbackThreads.map((thread) => {
          const rootId = thread.rootCommentId ?? thread.id;
          const threadComments = normalizedReviewComments
            .filter((comment) => (comment.inReplyToId ?? comment.id) === rootId)
            .map((comment) => ({
              id: comment.id,
              author: comment.author,
              body: comment.body,
              createdAt: "",
              updatedAt: comment.updatedAt,
              url: comment.url,
              side: comment.side,
            }));
          const lastActivityTime = parseTimestamp(thread.lastUpdatedAt);
          return {
            ...thread,
            hasNewActivitySinceLastReview:
              lastReviewTime !== null && lastActivityTime !== null ? lastActivityTime > lastReviewTime : false,
            comments: threadComments,
          };
        });

        const reviewThreads = await safeOptional(async () => {
          const threads = await fetchReviewThreadsGraphQL(deps.octokit, {
            owner: deps.owner,
            repo: deps.repo,
            pull_number: deps.pullNumber,
          });
          const normalized = threads.map((thread) => {
            const comments = thread.comments?.nodes ?? [];
            const normalizedComments = comments
              .filter((comment) => comment.databaseId !== null && comment.databaseId !== undefined)
              .map((comment) => ({
                id: comment.databaseId as number,
                author: comment.author?.login ?? "unknown",
                body: comment.body ?? "",
                createdAt: comment.createdAt ?? "",
                updatedAt: comment.updatedAt ?? comment.createdAt ?? "",
                url: comment.url ?? "",
                side: undefined,
              }))
              .filter((comment) => comment.updatedAt);
            if (normalizedComments.length === 0) return null;
            const lastUpdatedAt =
              [...normalizedComments]
                .map((item) => item.updatedAt)
                .sort((a, b) => b.localeCompare(a))[0] ?? "";
            const lastComment = [...normalizedComments].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
            const lastActivityTime = parseTimestamp(lastUpdatedAt);
            const rootComment = normalizedComments[0];
            return {
              id: rootComment.id,
              path: thread.path ?? "",
              line: thread.line ?? null,
              side: undefined,
              isOutdated: thread.isOutdated ?? false,
              resolved: thread.isResolved ?? false,
              lastUpdatedAt,
              lastActor: lastComment?.author ?? "unknown",
              hasNewActivitySinceLastReview:
                lastReviewTime !== null && lastActivityTime !== null ? lastActivityTime > lastReviewTime : false,
              rootCommentId: rootComment?.id ?? null,
              url: rootComment?.url ?? lastComment?.url ?? "",
              comments: normalizedComments,
            };
          }).filter((thread) => thread !== null) as ReviewContextPayload["reviewThreads"][number][];
          return normalized.length > 0 ? normalized : fallbackThreadsWithComments;
        });

        let commitsSinceLastReview: ReviewContextPayload["commitsSinceLastReview"] = [];
        if (lastReviewAt) {
          const commits = await safeCall(() =>
            deps.octokit.paginate(deps.octokit.rest.pulls.listCommits, {
              owner: deps.owner,
              repo: deps.repo,
              pull_number: deps.pullNumber,
              per_page: 100,
            })
          );
          const lastReviewTimeResolved = parseTimestamp(lastReviewAt) ?? 0;
          commitsSinceLastReview = commits
            .map((commit) => ({
              sha: commit.sha,
              message: commit.commit?.message ?? "",
              author: commit.author?.login ?? commit.commit?.author?.name ?? "unknown",
              date: commit.commit?.author?.date ?? commit.commit?.committer?.date ?? "",
              url: commit.html_url ?? "",
            }))
            .filter((commit) => {
              const commitTime = parseTimestamp(commit.date);
              if (commitTime === null) return false;
              return commitTime > lastReviewTimeResolved;
            });
        }

        deps.cache.reviewContext = {
          lastReviewAt,
          previousSummaries: summaries,
          reviewThreads: reviewThreads ?? fallbackThreadsWithComments,
          commitsSinceLastReview,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(deps.cache.reviewContext, null, 2) }],
        details: deps.cache.reviewContext,
      };
    },
  };

  return [getPrInfo, getChangedFiles, getFullChangedFiles, getDiff, getFullDiff, getReviewContext];
}

const PrInfoSchema = Type.Object({});
const ChangedFilesSchema = Type.Object({});
const ReviewContextSchema = Type.Object({});
const DiffSchema = Type.Object({
  path: Type.String({ description: "File path relative to repo root" }),
});

interface ReviewContextPayload {
  lastReviewAt: string | null;
  previousSummaries: Array<{
    id: number;
    author: string;
    createdAt: string;
    url: string;
    body: string;
  }>;
  reviewThreads: Array<{
    id: number;
    path: string;
    line: number | null;
    side?: "LEFT" | "RIGHT";
    isOutdated: boolean;
    resolved: boolean;
    lastUpdatedAt: string;
    lastActor: string;
    hasNewActivitySinceLastReview: boolean;
    rootCommentId: number | null;
    url: string;
    comments: Array<{
      id: number;
      author: string;
      body: string;
      createdAt: string;
      updatedAt: string;
      url: string;
      side?: "LEFT" | "RIGHT";
    }>;
  }>;
  commitsSinceLastReview: Array<{
    sha: string;
    message: string;
    author: string;
    date: string;
    url: string;
  }>;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

async function safeCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    if (error?.status === 403 && error?.message?.toLowerCase().includes("rate limit")) {
      throw new RateLimitError("GitHub API rate limit exceeded.");
    }
    throw error;
  }
}

async function safeOptional<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error: any) {
    return null;
  }
}
