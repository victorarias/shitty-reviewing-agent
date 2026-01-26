import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { getOctokit } from "@actions/github";
import { RateLimitError } from "./github.js";
import type { ChangedFile, ExistingComment, ReviewThreadInfo } from "../types.js";

type Octokit = ReturnType<typeof getOctokit>;

interface ReviewToolDeps {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  modelId: string;
  reviewSha: string;
  changedFiles: ChangedFile[];
  getBilling: () => { input: number; output: number; total: number; cost: number };
  existingComments: ExistingComment[];
  reviewThreads: ReviewThreadInfo[];
  onSummaryPosted?: () => void;
  onInlineComment?: () => void;
  onSuggestion?: () => void;
  summaryPosted?: () => boolean;
}

export function createReviewTools(deps: ReviewToolDeps): AgentTool<any>[] {
  const { existingByLocation, threadActivityById, threadLastActorById, threadLastCommentById } = buildLocationIndex(deps.existingComments);
  const { threadsByLocation, threadsById, threadsByRootCommentId } = buildThreadIndex(deps.reviewThreads);
  const patchByPath = new Map(deps.changedFiles.map((file) => [file.filename, file.patch]));
  const listThreadsTool: AgentTool<typeof ListThreadsSchema, { threads: ReviewThreadInfo[] }> = {
    name: "list_threads_for_location",
    label: "List review threads for location",
    description: "List existing review threads for a file/line (optionally filtered by side).",
    parameters: ListThreadsSchema,
    execute: async (_id, params) => {
      const side = params.side as "LEFT" | "RIGHT" | undefined;
      const threads = findThreadsAtLocation(threadsByLocation, params.path, params.line, side);
      return {
        content: [{ type: "text", text: JSON.stringify(threads, null, 2) }],
        details: { threads },
      };
    },
  };

  const commentTool: AgentTool<typeof CommentSchema, { id: number }> = {
    name: "comment",
    label: "Post inline comment",
    description: "Post an inline comment on a specific line in a file.",
    parameters: CommentSchema,
    execute: async (_id, params) => {
      const side = params.side as "LEFT" | "RIGHT" | undefined;
      if (params.thread_id) {
        const thread = threadsById.get(params.thread_id);
        if (!thread?.rootCommentId) {
          return {
            content: [{ type: "text", text: `Thread ${params.thread_id} not found or missing root comment.` }],
            details: { id: -1 },
          };
        }
        const latest = getLatestThreadComment(thread.rootCommentId, threadLastCommentById, thread.lastActor);
        if (latest && shouldUpdateDuplicateBot(latest.author, thread)) {
          return buildDuplicateUpdateResponse(params.path, params.line, latest.id, latest.author, thread.id);
        }
        const response = await safeCall(() =>
          deps.octokit.rest.pulls.createReplyForReviewComment({
            owner: deps.owner,
            repo: deps.repo,
            pull_number: deps.pullNumber,
            comment_id: thread.rootCommentId,
            body: params.body,
          })
        );
        deps.onInlineComment?.();
        return {
          content: [{ type: "text", text: `Reply posted: ${response.data.id}` }],
          details: { id: response.data.id },
        };
      }
      const diffCheck = lineExistsInDiff(patchByPath.get(params.path), params.line, side);
      if (!diffCheck.ok) {
        return {
          content: [{ type: "text", text: diffCheck.message }],
          details: { id: -1 },
        };
      }

      const threadsAtLocation = findThreadsAtLocation(threadsByLocation, params.path, params.line);
      if (threadsAtLocation.length > 0 && !params.allow_new_thread) {
        if (!side) {
          return buildThreadAmbiguityResponse(params.path, params.line, threadsAtLocation);
        }
        const sideThreads = threadsAtLocation.filter((thread) => thread.side === side);
        if (sideThreads.length > 1) {
          return buildThreadAmbiguityResponse(params.path, params.line, sideThreads, side);
        }
        if (sideThreads.length === 1) {
          const thread = sideThreads[0];
          if (thread.rootCommentId) {
            const latest = getLatestThreadComment(thread.rootCommentId, threadLastCommentById, thread.lastActor);
            if (latest && shouldUpdateDuplicateBot(latest.author, thread)) {
              return buildDuplicateUpdateResponse(params.path, params.line, latest.id, latest.author, thread.id);
            }
            const response = await safeCall(() =>
              deps.octokit.rest.pulls.createReplyForReviewComment({
                owner: deps.owner,
                repo: deps.repo,
                pull_number: deps.pullNumber,
                comment_id: thread.rootCommentId,
                body: params.body,
              })
            );
            deps.onInlineComment?.();
            return {
              content: [{ type: "text", text: `Reply posted: ${response.data.id}` }],
              details: { id: response.data.id },
            };
          }
          return {
            content: [{ type: "text", text: `Thread ${thread.id} missing root comment; choose another thread or open a new one.` }],
            details: { id: -1 },
          };
        }
      }

      const existing = findLatestLocation(existingByLocation, threadActivityById, params.path, params.line, side);
      if (existing && !params.allow_new_thread) {
        const thread = threadsByRootCommentId.get(existing.id);
        const latest = getLatestThreadComment(existing.id, threadLastCommentById, threadLastActorById.get(existing.id) ?? existing.author);
        if (latest && shouldUpdateDuplicateBot(latest.author, thread)) {
          return buildDuplicateUpdateResponse(params.path, params.line, latest.id, latest.author, thread?.id);
        }
        const response = await safeCall(() =>
          deps.octokit.rest.pulls.createReplyForReviewComment({
            owner: deps.owner,
            repo: deps.repo,
            pull_number: deps.pullNumber,
            comment_id: existing.id,
            body: params.body,
          })
        );
        deps.onInlineComment?.();
        return {
          content: [{ type: "text", text: `Reply posted: ${response.data.id}` }],
          details: { id: response.data.id },
        };
      }
      const response = await safeCall(() =>
        deps.octokit.rest.pulls.createReviewComment({
          owner: deps.owner,
          repo: deps.repo,
          pull_number: deps.pullNumber,
          commit_id: deps.headSha,
          path: params.path,
          line: params.line,
          side: side ?? "RIGHT",
          body: params.body,
        })
      );
      deps.onInlineComment?.();
      return {
        content: [{ type: "text", text: `Comment posted: ${response.data.id}` }],
        details: { id: response.data.id },
      };
    },
  };

  const suggestTool: AgentTool<typeof SuggestSchema, { id: number }> = {
    name: "suggest",
    label: "Post suggestion block",
    description: "Post a GitHub suggestion block (single-hunk fix).",
    parameters: SuggestSchema,
    execute: async (_id, params) => {
      const side = params.side as "LEFT" | "RIGHT" | undefined;
      const body = wrapSuggestion(params.suggestion, params.comment);
      if (params.thread_id) {
        const thread = threadsById.get(params.thread_id);
        if (!thread?.rootCommentId) {
          return {
            content: [{ type: "text", text: `Thread ${params.thread_id} not found or missing root comment.` }],
            details: { id: -1 },
          };
        }
        const latest = getLatestThreadComment(thread.rootCommentId, threadLastCommentById, thread.lastActor);
        if (latest && shouldUpdateDuplicateBot(latest.author, thread)) {
          return buildDuplicateUpdateResponse(params.path, params.line, latest.id, latest.author, thread.id);
        }
        const response = await safeCall(() =>
          deps.octokit.rest.pulls.createReplyForReviewComment({
            owner: deps.owner,
            repo: deps.repo,
            pull_number: deps.pullNumber,
            comment_id: thread.rootCommentId,
            body,
          })
        );
        deps.onSuggestion?.();
        return {
          content: [{ type: "text", text: `Suggestion reply posted: ${response.data.id}` }],
          details: { id: response.data.id },
        };
      }
      const diffCheck = lineExistsInDiff(patchByPath.get(params.path), params.line, side);
      if (!diffCheck.ok) {
        return {
          content: [{ type: "text", text: diffCheck.message }],
          details: { id: -1 },
        };
      }

      const threadsAtLocation = findThreadsAtLocation(threadsByLocation, params.path, params.line);
      if (threadsAtLocation.length > 0 && !params.allow_new_thread) {
        if (!side) {
          return buildThreadAmbiguityResponse(params.path, params.line, threadsAtLocation);
        }
        const sideThreads = threadsAtLocation.filter((thread) => thread.side === side);
        if (sideThreads.length > 1) {
          return buildThreadAmbiguityResponse(params.path, params.line, sideThreads, side);
        }
        if (sideThreads.length === 1) {
          const thread = sideThreads[0];
          if (thread.rootCommentId) {
            const latest = getLatestThreadComment(thread.rootCommentId, threadLastCommentById, thread.lastActor);
            if (latest && shouldUpdateDuplicateBot(latest.author, thread)) {
              return buildDuplicateUpdateResponse(params.path, params.line, latest.id, latest.author, thread.id);
            }
            const response = await safeCall(() =>
              deps.octokit.rest.pulls.createReplyForReviewComment({
                owner: deps.owner,
                repo: deps.repo,
                pull_number: deps.pullNumber,
                comment_id: thread.rootCommentId,
                body,
              })
            );
            deps.onSuggestion?.();
            return {
              content: [{ type: "text", text: `Suggestion reply posted: ${response.data.id}` }],
              details: { id: response.data.id },
            };
          }
          return {
            content: [{ type: "text", text: `Thread ${thread.id} missing root comment; choose another thread or open a new one.` }],
            details: { id: -1 },
          };
        }
      }

      const existing = findLatestLocation(existingByLocation, threadActivityById, params.path, params.line, side);
      if (existing && !params.allow_new_thread) {
        const thread = threadsByRootCommentId.get(existing.id);
        const latest = getLatestThreadComment(existing.id, threadLastCommentById, threadLastActorById.get(existing.id) ?? existing.author);
        if (latest && shouldUpdateDuplicateBot(latest.author, thread)) {
          return buildDuplicateUpdateResponse(params.path, params.line, latest.id, latest.author, thread?.id);
        }
        const response = await safeCall(() =>
          deps.octokit.rest.pulls.createReplyForReviewComment({
            owner: deps.owner,
            repo: deps.repo,
            pull_number: deps.pullNumber,
            comment_id: existing.id,
            body,
          })
        );
        deps.onSuggestion?.();
        return {
          content: [{ type: "text", text: `Suggestion reply posted: ${response.data.id}` }],
          details: { id: response.data.id },
        };
      }
      const response = await safeCall(() =>
        deps.octokit.rest.pulls.createReviewComment({
          owner: deps.owner,
          repo: deps.repo,
          pull_number: deps.pullNumber,
          commit_id: deps.headSha,
          path: params.path,
          line: params.line,
          side: side ?? "RIGHT",
          body,
        })
      );
      deps.onSuggestion?.();
      return {
        content: [{ type: "text", text: `Suggestion posted: ${response.data.id}` }],
        details: { id: response.data.id },
      };
    },
  };

  const updateTool: AgentTool<typeof UpdateSchema, { id: number }> = {
    name: "update_comment",
    label: "Update review comment",
    description: "Update an existing review comment in place.",
    parameters: UpdateSchema,
    execute: async (_id, params) => {
      const response = await safeCall(() =>
        deps.octokit.rest.pulls.updateReviewComment({
          owner: deps.owner,
          repo: deps.repo,
          comment_id: params.comment_id,
          body: params.body,
        })
      );
      return {
        content: [{ type: "text", text: `Comment updated: ${response.data.id}` }],
        details: { id: response.data.id },
      };
    },
  };

  const replyTool: AgentTool<typeof ReplySchema, { id: number }> = {
    name: "reply_comment",
    label: "Reply to review comment",
    description: "Reply to an existing review comment thread.",
    parameters: ReplySchema,
    execute: async (_id, params) => {
      const response = await safeCall(() =>
        deps.octokit.rest.pulls.createReplyForReviewComment({
          owner: deps.owner,
          repo: deps.repo,
          pull_number: deps.pullNumber,
          comment_id: params.comment_id,
          body: params.body,
        })
      );
      return {
        content: [{ type: "text", text: `Reply posted: ${response.data.id}` }],
        details: { id: response.data.id },
      };
    },
  };

  const summaryTool: AgentTool<typeof SummarySchema, { id: number }> = {
    name: "post_summary",
    label: "Post summary",
    description: "Post the final review summary as a PR comment.",
    parameters: SummarySchema,
    execute: async (_id, params) => {
      if (deps.summaryPosted?.()) {
        return {
          content: [{ type: "text", text: "Summary already posted. Skipping duplicate." }],
          details: { id: -1 },
        };
      }
      // Mark as posted immediately to prevent racing duplicate calls.
      deps.onSummaryPosted?.();
      const body = ensureSummaryFooter(params.body, deps.modelId, deps.getBilling(), deps.reviewSha);
      const response = await safeCall(() =>
        deps.octokit.rest.issues.createComment({
          owner: deps.owner,
          repo: deps.repo,
          issue_number: deps.pullNumber,
          body,
        })
      );
      return {
        content: [{ type: "text", text: `Summary posted: ${response.data.id}` }],
        details: { id: response.data.id },
      };
    },
  };

  return [listThreadsTool, commentTool, suggestTool, updateTool, replyTool, summaryTool];
}

const CommentSchema = Type.Object({
  path: Type.String({ description: "File path" }),
  line: Type.Integer({ minimum: 1 }),
  side: Type.Optional(Type.String({ description: "LEFT or RIGHT", enum: ["LEFT", "RIGHT"] })),
  thread_id: Type.Optional(Type.Integer({ minimum: 1, description: "Existing thread id to reply to." })),
  allow_new_thread: Type.Optional(Type.Boolean({ description: "Set true to force a new thread even if one exists." })),
  body: Type.String({ description: "Markdown body" }),
});

const SuggestSchema = Type.Object({
  path: Type.String({ description: "File path" }),
  line: Type.Integer({ minimum: 1 }),
  side: Type.Optional(Type.String({ description: "LEFT or RIGHT", enum: ["LEFT", "RIGHT"] })),
  thread_id: Type.Optional(Type.Integer({ minimum: 1, description: "Existing thread id to reply to." })),
  allow_new_thread: Type.Optional(Type.Boolean({ description: "Set true to force a new thread even if one exists." })),
  comment: Type.Optional(Type.String({ description: "Optional comment before suggestion" })),
  suggestion: Type.String({ description: "Replacement code for suggestion block" }),
});

const ListThreadsSchema = Type.Object({
  path: Type.String({ description: "File path" }),
  line: Type.Integer({ minimum: 1 }),
  side: Type.Optional(Type.String({ description: "LEFT or RIGHT", enum: ["LEFT", "RIGHT"] })),
});

const SummarySchema = Type.Object({
  body: Type.String({ description: "Markdown summary" }),
});

const ReplySchema = Type.Object({
  comment_id: Type.Integer({ minimum: 1 }),
  body: Type.String({ description: "Reply body" }),
});

const UpdateSchema = Type.Object({
  comment_id: Type.Integer({ minimum: 1 }),
  body: Type.String({ description: "Updated comment body" }),
});

function wrapSuggestion(suggestion: string, comment?: string): string {
  const prefix = comment?.trim() ? `${comment.trim()}\n\n` : "";
  return `${prefix}\`\`\`suggestion\n${suggestion}\n\`\`\``;
}

function buildLocationIndex(comments: ExistingComment[]): {
  existingByLocation: Map<string, ExistingComment[]>;
  threadActivityById: Map<number, string>;
  threadLastActorById: Map<number, string>;
  threadLastCommentById: Map<number, { id: number; author?: string; updatedAt: string }>;
} {
  const map = new Map<string, ExistingComment[]>();
  const activity = new Map<number, string>();
  const lastActorById = new Map<number, string>();
  const lastCommentById = new Map<number, { id: number; author?: string; updatedAt: string }>();
  for (const comment of comments) {
    if (comment.type !== "review" || !comment.path || !comment.line) continue;
    const rootId = comment.inReplyToId ?? comment.id;
    const lastComment = lastCommentById.get(rootId);
    if (!lastComment || lastComment.updatedAt.localeCompare(comment.updatedAt) < 0) {
      lastCommentById.set(rootId, { id: comment.id, author: comment.author, updatedAt: comment.updatedAt });
    }
    const lastActivity = activity.get(rootId);
    if (!lastActivity || lastActivity.localeCompare(comment.updatedAt) < 0) {
      activity.set(rootId, comment.updatedAt);
      if (comment.author) {
        lastActorById.set(rootId, comment.author);
      }
    }
    if (comment.inReplyToId) continue;
    const key = `${comment.path}:${comment.line}:${comment.side ?? "RIGHT"}`;
    const list = map.get(key) ?? [];
    list.push(comment);
    map.set(key, list);
  }
  return {
    existingByLocation: map,
    threadActivityById: activity,
    threadLastActorById: lastActorById,
    threadLastCommentById: lastCommentById,
  };
}

function findLatestLocation(
  map: Map<string, ExistingComment[]>,
  activity: Map<number, string>,
  path: string,
  line: number,
  side?: "LEFT" | "RIGHT"
): ExistingComment | undefined {
  const list = side ? map.get(`${path}:${line}:${side}`) : map.get(`${path}:${line}:RIGHT`) ?? map.get(`${path}:${line}:LEFT`);
  if (!list || list.length === 0) return undefined;
  return [...list].sort((a, b) => {
    const aActivity = activity.get(a.id) ?? a.updatedAt;
    const bActivity = activity.get(b.id) ?? b.updatedAt;
    return bActivity.localeCompare(aActivity);
  })[0];
}

function buildThreadIndex(threads: ReviewThreadInfo[]): {
  threadsByLocation: Map<string, ReviewThreadInfo[]>;
  threadsById: Map<number, ReviewThreadInfo>;
  threadsByRootCommentId: Map<number, ReviewThreadInfo>;
} {
  const byLocation = new Map<string, ReviewThreadInfo[]>();
  const byId = new Map<number, ReviewThreadInfo>();
  const byRootCommentId = new Map<number, ReviewThreadInfo>();
  for (const thread of threads) {
    if (!thread.path || thread.line === null) continue;
    byId.set(thread.id, thread);
    if (thread.rootCommentId) {
      byRootCommentId.set(thread.rootCommentId, thread);
    }
    if (thread.side) {
      const sideKey = `${thread.path}:${thread.line}:${thread.side}`;
      const sideList = byLocation.get(sideKey) ?? [];
      sideList.push(thread);
      byLocation.set(sideKey, sideList);
    } else {
      const noSideKey = `${thread.path}:${thread.line}`;
      const noSideList = byLocation.get(noSideKey) ?? [];
      noSideList.push(thread);
      byLocation.set(noSideKey, noSideList);
    }
  }
  return { threadsByLocation: byLocation, threadsById: byId, threadsByRootCommentId: byRootCommentId };
}

function findThreadsAtLocation(
  map: Map<string, ReviewThreadInfo[]>,
  path: string,
  line: number,
  side?: "LEFT" | "RIGHT"
): ReviewThreadInfo[] {
  const noSide = map.get(`${path}:${line}`) ?? [];
  if (side) {
    const withSide = map.get(`${path}:${line}:${side}`) ?? [];
    return [...noSide, ...withSide];
  }
  const right = map.get(`${path}:${line}:RIGHT`) ?? [];
  const left = map.get(`${path}:${line}:LEFT`) ?? [];
  return [...noSide, ...right, ...left];
}

function buildThreadAmbiguityResponse(
  path: string,
  line: number,
  threads: ReviewThreadInfo[],
  side?: "LEFT" | "RIGHT"
): { content: { type: "text"; text: string }[]; details: { id: number } } {
  const header = side
    ? `Multiple threads exist at ${path}:${line} for side ${side}.`
    : `Threads exist at ${path}:${line}. You must choose how to proceed.`;
  const guidance = side
    ? "Pick a thread_id from the list below to reply, OR set allow_new_thread=true to create a new thread."
    : "Reply with thread_id, OR specify side (LEFT/RIGHT) to target a single thread, OR set allow_new_thread=true to create a new thread.";
  const formatted = threads
    .map(
      (thread) =>
        `- thread_id=${thread.id} root_comment_id=${thread.rootCommentId ?? "unknown"} side=${thread.side ?? "unknown"} resolved=${thread.resolved} outdated=${thread.isOutdated} last=${thread.lastUpdatedAt} actor=${thread.lastActor}`
    )
    .join("\n");
  return {
    content: [{ type: "text", text: `${header}\n${guidance}\n${formatted}` }],
    details: { id: -1 },
  };
}

function lineExistsInDiff(
  patch: string | undefined,
  line: number,
  side?: "LEFT" | "RIGHT"
): { ok: boolean; message: string } {
  if (!patch) {
    return {
      ok: false,
      message: "No diff available for this file. It may be binary or too large to diff; avoid inline comments.",
    };
  }
  if (!side) {
    return {
      ok: false,
      message: "Missing side (LEFT or RIGHT). Specify side to validate the diff line.",
    };
  }
  const matches = lineInPatch(patch, line, side);
  if (!matches) {
    return {
      ok: false,
      message: `Line ${line} is not present on ${side} side of the diff for this file. Use get_diff to find a valid line.`,
    };
  }
  return { ok: true, message: "ok" };
}

function lineInPatch(patch: string, targetLine: number, side: "LEFT" | "RIGHT"): boolean {
  const lines = patch.split(/\r?\n/);
  let oldLine = 0;
  let newLine = 0;
  for (const line of lines) {
    const header = line.match(/^@@ -(\d+),?\d* \+(\d+),?\d* @@/);
    if (header) {
      oldLine = Number.parseInt(header[1], 10);
      newLine = Number.parseInt(header[2], 10);
      continue;
    }
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+")) {
      if (side === "RIGHT" && newLine === targetLine) return true;
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      if (side === "LEFT" && oldLine === targetLine) return true;
      oldLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      if (side === "RIGHT" && newLine === targetLine) return true;
      if (side === "LEFT" && oldLine === targetLine) return true;
      oldLine += 1;
      newLine += 1;
      continue;
    }
  }
  return false;
}
function ensureSummaryFooter(
  body: string,
  modelId: string,
  billing: { input: number; output: number; total: number; cost: number },
  reviewSha: string
): string {
  const hasFooter = body.includes("Reviewed by shitty-reviewing-agent");
  const billingLine = `*Billing: input ${billing.input} • output ${billing.output} • total ${billing.total} • cost $${billing.cost.toFixed(6)}*`;
  const marker = `<!-- sri:last-reviewed-sha:${reviewSha} -->`;
  const footer = `---\n*Reviewed by shitty-reviewing-agent • model: ${modelId}*\n${billingLine}\n${marker}`;
  if (hasFooter) {
    if (body.includes("Billing: input")) {
      return body.includes("sri:last-reviewed-sha") ? body : `${body}\n${marker}`;
    }
    return `${body}\n${billingLine}\n${marker}`;
  }
  return `${body.trim()}\n\n${footer}`;
}

function shouldUpdateDuplicateBot(actor?: string, thread?: ReviewThreadInfo): boolean {
  if (!actor) return false;
  const isBot = actor.toLowerCase().endsWith("[bot]");
  const unresolved = thread?.resolved !== true;
  return isBot && unresolved;
}

function getLatestThreadComment(
  rootCommentId: number | null,
  lastCommentById: Map<number, { id: number; author?: string; updatedAt: string }>,
  fallbackAuthor?: string
): { id: number; author?: string } | null {
  if (!rootCommentId) return null;
  const latest = lastCommentById.get(rootCommentId);
  if (latest) {
    return { id: latest.id, author: latest.author };
  }
  return { id: rootCommentId, author: fallbackAuthor };
}

function buildDuplicateUpdateResponse(
  path: string,
  line: number,
  commentId: number,
  actor?: string,
  threadId?: number
): { content: { type: "text"; text: string }[]; details: { id: number } } {
  const location = `${path}:${line}`;
  const actorLabel = actor ?? "unknown";
  const threadLabel = threadId ? ` thread=${threadId}` : "";
  return {
    content: [{
      type: "text",
      text: `Latest unresolved comment at ${location}${threadLabel} is by ${actorLabel}. Use update_comment with comment_id=${commentId}.`,
    }],
    details: { id: -1 },
  };
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
