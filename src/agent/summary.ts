import type { getOctokit } from "@actions/github";
import { buildSummaryMarkdown } from "../summary.js";

type Octokit = ReturnType<typeof getOctokit>;

export function deriveErrorReason(message: string): string {
  if (isQuotaError(message)) {
    return "LLM quota exceeded or rate-limited; unable to generate a review. Check provider billing/limits.";
  }
  return "Agent encountered an error and failed to produce a review summary.";
}

export function isQuotaError(message: string): boolean {
  return /quota|resource_exhausted|rate limit|429/i.test(message);
}

export async function postFailureSummary(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  reason: string;
  model: string;
  billing: {
    input: number;
    output: number;
    total: number;
    cost: number;
  };
  reviewSha: string;
}): Promise<void> {
  await params.octokit.rest.issues.createComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.prNumber,
    body: buildSummaryMarkdown({
      verdict: "Skipped",
      issues: [params.reason],
      keyFindings: ["None"],
      multiFileSuggestions: ["None"],
      model: params.model,
      billing: params.billing,
      reviewSha: params.reviewSha,
    }),
  });
}

export async function postFallbackSummary(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  model: string;
  verdict: string;
  reason: string;
  billing: {
    input: number;
    output: number;
    total: number;
    cost: number;
  };
  reviewSha: string;
}): Promise<void> {
  await params.octokit.rest.issues.createComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.prNumber,
    body: buildSummaryMarkdown({
      verdict: params.verdict,
      issues: [params.reason],
      keyFindings: ["None"],
      multiFileSuggestions: ["None"],
      model: params.model,
      billing: params.billing,
      reviewSha: params.reviewSha,
    }),
  });
}
