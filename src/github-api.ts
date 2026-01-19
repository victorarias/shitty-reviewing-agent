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
      return [];
    }
    throw error;
  }
}
