import type { getOctokit } from "@actions/github";
import type { ReviewThreadInfo } from "./types.js";

type Octokit = ReturnType<typeof getOctokit>;

type ReviewThreadCommentGraphQL = {
  databaseId?: number | null;
  author?: { login?: string | null } | null;
  body?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  url?: string | null;
};

type ReviewThreadGraphQL = {
  id: string;
  isResolved?: boolean | null;
  isOutdated?: boolean | null;
  path?: string | null;
  line?: number | null;
  comments?: { nodes?: ReviewThreadCommentGraphQL[] | null } | null;
};

type ReviewThreadGraphQLResponse = {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        nodes?: ReviewThreadGraphQL[] | null;
        pageInfo?: { hasNextPage: boolean; endCursor?: string | null } | null;
      } | null;
    } | null;
  } | null;
};

const REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 100) {
            nodes {
              databaseId
              author { login }
              body
              createdAt
              updatedAt
              url
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}`;

export async function fetchReviewThreadsGraphQL(
  octokit: Octokit,
  params: { owner: string; repo: string; pull_number: number }
): Promise<ReviewThreadGraphQL[]> {
  const results: ReviewThreadGraphQL[] = [];
  let after: string | null = null;

  while (true) {
    const response = await octokit.graphql<ReviewThreadGraphQLResponse>(REVIEW_THREADS_QUERY, {
      owner: params.owner,
      repo: params.repo,
      number: params.pull_number,
      after,
    });

    const connection = response.repository?.pullRequest?.reviewThreads;
    const nodes = connection?.nodes ?? [];
    results.push(...nodes);

    const pageInfo = connection?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) {
      break;
    }
    after = pageInfo.endCursor;
  }

  return results;
}

export function normalizeReviewThreadsGraphQL(threads: ReviewThreadGraphQL[]): ReviewThreadInfo[] {
  const normalized: ReviewThreadInfo[] = [];
  for (const thread of threads) {
    const comments = thread.comments?.nodes ?? [];
    const withIds = comments
      .filter((comment) => comment.databaseId !== null && comment.databaseId !== undefined)
      .map((comment) => ({
        id: comment.databaseId as number,
        author: comment.author?.login ?? "unknown",
        updatedAt: comment.updatedAt ?? comment.createdAt ?? "",
        url: comment.url ?? "",
      }))
      .filter((comment) => comment.updatedAt);

    if (withIds.length === 0) continue;
    const root = withIds[0];
    const last = [...withIds].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

    normalized.push({
      id: root.id,
      path: thread.path ?? "",
      line: thread.line ?? null,
      side: undefined,
      isOutdated: thread.isOutdated ?? false,
      resolved: thread.isResolved ?? false,
      lastUpdatedAt: last?.updatedAt ?? "",
      lastActor: last?.author ?? "unknown",
      rootCommentId: root.id,
      url: root.url ?? last?.url ?? "",
    });
  }
  return normalized;
}
