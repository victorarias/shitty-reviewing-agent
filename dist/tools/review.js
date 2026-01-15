import { Type } from "@sinclair/typebox";
import { RateLimitError } from "./github.js";
import crypto from "node:crypto";
export function createReviewTools(deps) {
    const postedKeys = new Set();
    const existingKeys = new Set();
    const existingByLocation = buildLocationIndex(deps.existingComments);
    for (const comment of deps.existingComments) {
        if (comment.type === "review" && comment.path && comment.line) {
            existingKeys.add(hashKey(comment.path, comment.line, comment.body));
        }
    }
    const commentTool = {
        name: "comment",
        label: "Post inline comment",
        description: "Post an inline comment on a specific line in a file.",
        parameters: CommentSchema,
        execute: async (_id, params) => {
            const side = params.side;
            const key = hashKey(params.path, params.line, params.body);
            if (postedKeys.has(key) || existingKeys.has(key)) {
                return {
                    content: [{ type: "text", text: "Duplicate comment skipped." }],
                    details: { id: -1 },
                };
            }
            const existing = findLatestLocation(existingByLocation, params.path, params.line);
            if (existing) {
                const response = await safeCall(() => deps.octokit.rest.pulls.createReplyForReviewComment({
                    owner: deps.owner,
                    repo: deps.repo,
                    pull_number: deps.pullNumber,
                    comment_id: existing.id,
                    body: params.body,
                }));
                postedKeys.add(key);
                deps.onInlineComment?.();
                return {
                    content: [{ type: "text", text: `Reply posted: ${response.data.id}` }],
                    details: { id: response.data.id },
                };
            }
            const response = await safeCall(() => deps.octokit.rest.pulls.createReviewComment({
                owner: deps.owner,
                repo: deps.repo,
                pull_number: deps.pullNumber,
                commit_id: deps.headSha,
                path: params.path,
                line: params.line,
                side: side ?? "RIGHT",
                body: params.body,
            }));
            postedKeys.add(key);
            deps.onInlineComment?.();
            return {
                content: [{ type: "text", text: `Comment posted: ${response.data.id}` }],
                details: { id: response.data.id },
            };
        },
    };
    const suggestTool = {
        name: "suggest",
        label: "Post suggestion block",
        description: "Post a GitHub suggestion block (single-hunk fix).",
        parameters: SuggestSchema,
        execute: async (_id, params) => {
            const side = params.side;
            const body = wrapSuggestion(params.suggestion, params.comment);
            const key = hashKey(params.path, params.line, body);
            if (postedKeys.has(key) || existingKeys.has(key)) {
                return {
                    content: [{ type: "text", text: "Duplicate suggestion skipped." }],
                    details: { id: -1 },
                };
            }
            const existing = findLatestLocation(existingByLocation, params.path, params.line);
            if (existing) {
                const response = await safeCall(() => deps.octokit.rest.pulls.createReplyForReviewComment({
                    owner: deps.owner,
                    repo: deps.repo,
                    pull_number: deps.pullNumber,
                    comment_id: existing.id,
                    body,
                }));
                postedKeys.add(key);
                deps.onSuggestion?.();
                return {
                    content: [{ type: "text", text: `Suggestion reply posted: ${response.data.id}` }],
                    details: { id: response.data.id },
                };
            }
            const response = await safeCall(() => deps.octokit.rest.pulls.createReviewComment({
                owner: deps.owner,
                repo: deps.repo,
                pull_number: deps.pullNumber,
                commit_id: deps.headSha,
                path: params.path,
                line: params.line,
                side: side ?? "RIGHT",
                body,
            }));
            postedKeys.add(key);
            deps.onSuggestion?.();
            return {
                content: [{ type: "text", text: `Suggestion posted: ${response.data.id}` }],
                details: { id: response.data.id },
            };
        },
    };
    const replyTool = {
        name: "reply_comment",
        label: "Reply to review comment",
        description: "Reply to an existing review comment thread.",
        parameters: ReplySchema,
        execute: async (_id, params) => {
            const response = await safeCall(() => deps.octokit.rest.pulls.createReplyForReviewComment({
                owner: deps.owner,
                repo: deps.repo,
                pull_number: deps.pullNumber,
                comment_id: params.comment_id,
                body: params.body,
            }));
            return {
                content: [{ type: "text", text: `Reply posted: ${response.data.id}` }],
                details: { id: response.data.id },
            };
        },
    };
    const summaryTool = {
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
            const response = await safeCall(() => deps.octokit.rest.issues.createComment({
                owner: deps.owner,
                repo: deps.repo,
                issue_number: deps.pullNumber,
                body,
            }));
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
function wrapSuggestion(suggestion, comment) {
    const prefix = comment?.trim() ? `${comment.trim()}\n\n` : "";
    return `${prefix}\`\`\`suggestion\n${suggestion}\n\`\`\``;
}
function normalizeBody(body) {
    return body.replace(/\s+/g, " ").trim().toLowerCase();
}
function hashKey(path, line, body) {
    const hash = crypto.createHash("sha256");
    hash.update(`${path}:${line}:${normalizeBody(body)}`);
    return hash.digest("hex");
}
function buildLocationIndex(comments) {
    const map = new Map();
    for (const comment of comments) {
        if (comment.type !== "review" || !comment.path || !comment.line)
            continue;
        const key = `${comment.path}:${comment.line}`;
        const list = map.get(key) ?? [];
        list.push(comment);
        map.set(key, list);
    }
    return map;
}
function findLatestLocation(map, path, line) {
    const list = map.get(`${path}:${line}`);
    if (!list || list.length === 0)
        return undefined;
    return [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}
function ensureSummaryFooter(body, modelId, billing, reviewSha) {
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
async function safeCall(fn) {
    try {
        return await fn();
    }
    catch (error) {
        if (error?.status === 403 && error?.message?.toLowerCase().includes("rate limit")) {
            throw new RateLimitError("GitHub API rate limit exceeded.");
        }
        throw error;
    }
}
