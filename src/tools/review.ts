import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { getOctokit } from "@actions/github";
import { RateLimitError } from "./github.js";
import type { ExistingComment } from "../types.js";

type Octokit = ReturnType<typeof getOctokit>;

interface ReviewToolDeps {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  modelId: string;
  reviewSha: string;
  getBilling: () => { input: number; output: number; total: number; cost: number };
  existingComments: ExistingComment[];
  onSummaryPosted?: () => void;
  onInlineComment?: () => void;
  onSuggestion?: () => void;
  summaryPosted?: () => boolean;
}

export function createReviewTools(deps: ReviewToolDeps): AgentTool<any>[] {
  const { existingByLocation, threadActivityById } = buildLocationIndex(deps.existingComments);

  const commentTool: AgentTool<typeof CommentSchema, { id: number }> = {
    name: "comment",
    label: "Post inline comment",
    description: "Post an inline comment on a specific line in a file.",
    parameters: CommentSchema,
    execute: async (_id, params) => {
      const side = params.side as "LEFT" | "RIGHT" | undefined;
      const existing = findLatestLocation(existingByLocation, threadActivityById, params.path, params.line);
      if (existing) {
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
      const existing = findLatestLocation(existingByLocation, threadActivityById, params.path, params.line);
      if (existing) {
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

  return [commentTool, suggestTool, replyTool, summaryTool];
}

const CommentSchema = Type.Object({
  path: Type.String({ description: "File path" }),
  line: Type.Integer({ minimum: 1 }),
  side: Type.Optional(Type.String({ description: "LEFT or RIGHT", enum: ["LEFT", "RIGHT"] })),
  body: Type.String({ description: "Markdown body" }),
});

const SuggestSchema = Type.Object({
  path: Type.String({ description: "File path" }),
  line: Type.Integer({ minimum: 1 }),
  side: Type.Optional(Type.String({ description: "LEFT or RIGHT", enum: ["LEFT", "RIGHT"] })),
  comment: Type.Optional(Type.String({ description: "Optional comment before suggestion" })),
  suggestion: Type.String({ description: "Replacement code for suggestion block" }),
});

const SummarySchema = Type.Object({
  body: Type.String({ description: "Markdown summary" }),
});

const ReplySchema = Type.Object({
  comment_id: Type.Integer({ minimum: 1 }),
  body: Type.String({ description: "Reply body" }),
});

function wrapSuggestion(suggestion: string, comment?: string): string {
  const prefix = comment?.trim() ? `${comment.trim()}\n\n` : "";
  return `${prefix}\`\`\`suggestion\n${suggestion}\n\`\`\``;
}

function buildLocationIndex(comments: ExistingComment[]): {
  existingByLocation: Map<string, ExistingComment[]>;
  threadActivityById: Map<number, string>;
} {
  const map = new Map<string, ExistingComment[]>();
  const activity = new Map<number, string>();
  for (const comment of comments) {
    if (comment.type !== "review" || !comment.path || !comment.line) continue;
    const rootId = comment.inReplyToId ?? comment.id;
    const lastActivity = activity.get(rootId);
    if (!lastActivity || lastActivity.localeCompare(comment.updatedAt) < 0) {
      activity.set(rootId, comment.updatedAt);
    }
    if (comment.inReplyToId) continue;
    const key = `${comment.path}:${comment.line}`;
    const list = map.get(key) ?? [];
    list.push(comment);
    map.set(key, list);
  }
  return { existingByLocation: map, threadActivityById: activity };
}

function findLatestLocation(
  map: Map<string, ExistingComment[]>,
  activity: Map<number, string>,
  path: string,
  line: number
): ExistingComment | undefined {
  const list = map.get(`${path}:${line}`);
  if (!list || list.length === 0) return undefined;
  return [...list].sort((a, b) => {
    const aActivity = activity.get(a.id) ?? a.updatedAt;
    const bActivity = activity.get(b.id) ?? b.updatedAt;
    return bActivity.localeCompare(aActivity);
  })[0];
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
