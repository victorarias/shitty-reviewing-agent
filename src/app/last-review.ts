import type { ExistingComment } from "../types.js";

export function findLastReviewedSha(comments: ExistingComment[]): string | null {
  const marker = "<!-- sri:last-reviewed-sha:";
  const candidates = comments
    .filter((comment) => comment.type === "issue" && comment.body.includes(marker))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const comment of candidates) {
    const match = comment.body.match(/<!--\s*sri:last-reviewed-sha:([a-f0-9]{7,40})\s*-->/i);
    if (match) {
      return match[1];
    }
  }
  return null;
}

export function findLastSummary(comments: ExistingComment[]): { verdict: string; url: string; updatedAt: string; body: string } | null {
  const candidates = comments
    .filter((comment) => comment.type === "issue" && comment.body.includes("## Review Summary"))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const comment of candidates) {
    const match = comment.body.match(/\*\*Verdict:\*\*\s*(Request Changes|Approve|Skipped)/i);
    if (match) {
      return {
        verdict: match[1],
        url: comment.url,
        updatedAt: comment.updatedAt,
        body: comment.body,
      };
    }
  }
  return null;
}
