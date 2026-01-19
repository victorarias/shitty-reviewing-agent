import type { getOctokit } from "@actions/github";
import type { RequestInterface } from "@octokit/types";

type Octokit = ReturnType<typeof getOctokit>;

type ReviewThreadCommentApi = {
  id: number;
  user?: { login?: string | null } | null;
  body?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  html_url?: string | null;
  side?: "LEFT" | "RIGHT";
  start_side?: "LEFT" | "RIGHT";
  path?: string | null;
  line?: number | null;
};

type ReviewThreadApi = {
  id: number;
  path?: string;
  line?: number | null;
  side?: "LEFT" | "RIGHT";
  start_side?: "LEFT" | "RIGHT";
  is_outdated?: boolean;
  resolved?: boolean;
  comments?: ReviewThreadCommentApi[];
};

export async function listReviewThreads(
  octokit: Octokit,
  params: { owner: string; repo: string; pull_number: number }
): Promise<ReviewThreadApi[]> {
  const request = octokit.request as RequestInterface;
  try {
    const results: ReviewThreadApi[] = [];
    let page = 1;
    while (true) {
      const response = await request("GET /repos/{owner}/{repo}/pulls/{pull_number}/threads", {
        ...params,
        per_page: 100,
        page,
      });
      const data = response.data as ReviewThreadApi[];
      results.push(...data);
      if (data.length < 100) break;
      page += 1;
    }
    return results;
  } catch (error: any) {
    const status = error?.status ?? error?.response?.status;
    if (status === 404) {
      // Some repos/tokens do not have access to review threads; treat as unavailable.
      console.warn(
        `[warn] Unable to list review threads (404) for ${params.owner}/${params.repo}#${params.pull_number}; continuing without threads.`
      );
      logRequestDetails(error);
      await logTokenScopes(request);
      return [];
    }
    const message = error?.message ? String(error.message) : String(error);
    throw new Error(
      `Failed to list review threads for ${params.owner}/${params.repo}#${params.pull_number} (status ${status ?? "unknown"}): ${message}`,
      { cause: error }
    );
  }
}

function logRequestDetails(error: any): void {
  const response = error?.response;
  if (!response) return;
  const requestId = response.headers?.["x-github-request-id"] ?? "unknown";
  const docUrl = response.data?.documentation_url ?? "unknown";
  const url = response.url ?? response.config?.url ?? "unknown";
  console.warn(
    `[warn] listReviewThreads 404 details: request_id=${requestId} url=${url} doc=${docUrl}`
  );
}

async function logTokenScopes(request: RequestInterface): Promise<void> {
  const debug = (process.env.INPUT_DEBUG ?? "").toLowerCase() === "true";
  if (!debug) return;
  try {
    const response = await request("GET /rate_limit", {});
    const oauthScopes = response.headers?.["x-oauth-scopes"] ?? "unknown";
    const acceptedScopes = response.headers?.["x-accepted-oauth-scopes"] ?? "unknown";
    const actor = process.env.GITHUB_ACTOR ?? "unknown";
    const event = process.env.GITHUB_EVENT_NAME ?? "unknown";
    const ref = process.env.GITHUB_REF ?? "unknown";
    console.warn(
      `[debug] token scopes: oauth=${oauthScopes} accepted=${acceptedScopes} actor=${actor} event=${event} ref=${ref}`
    );
  } catch (err: any) {
    const message = err?.message ? String(err.message) : String(err);
    console.warn(`[warn] Unable to fetch token scopes via rate_limit: ${message}`);
  }
}
