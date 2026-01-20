import type { ExistingComment, ReviewThreadInfo } from "./types.js";

export function buildThreadsFromReviewComments(comments: ExistingComment[]): ReviewThreadInfo[] {
  const reviewComments = comments.filter((comment) => comment.type === "review");
  const groups = new Map<number, ExistingComment[]>();

  for (const comment of reviewComments) {
    if (!comment.path || !comment.line) continue;
    const rootId = comment.inReplyToId ?? comment.id;
    const list = groups.get(rootId) ?? [];
    list.push(comment);
    groups.set(rootId, list);
  }

  const threads: ReviewThreadInfo[] = [];
  for (const [rootId, group] of groups) {
    const root = group.find((comment) => comment.id === rootId) ?? group[0];
    const sorted = [...group].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const last = sorted[0];
    if (!root.path || !root.line) continue;
    threads.push({
      id: rootId,
      path: root.path,
      line: root.line,
      side: root.side,
      isOutdated: false,
      resolved: false,
      lastUpdatedAt: last.updatedAt,
      lastActor: last.author ?? "unknown",
      rootCommentId: rootId,
      url: root.url,
    });
  }

  return threads;
}
