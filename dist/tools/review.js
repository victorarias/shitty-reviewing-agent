import { Type } from "@sinclair/typebox";
import { RateLimitError } from "./github.js";
export function createReviewTools(deps) {
    const commentTool = {
        name: "comment",
        label: "Post inline comment",
        description: "Post an inline comment on a specific line in a file.",
        parameters: CommentSchema,
        execute: async (_id, params) => {
            const side = params.side;
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
            deps.onSuggestion?.();
            return {
                content: [{ type: "text", text: `Suggestion posted: ${response.data.id}` }],
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
            const body = ensureSummaryFooter(params.body, deps.modelId, deps.getBilling());
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
    return [commentTool, suggestTool, summaryTool];
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
function wrapSuggestion(suggestion, comment) {
    const prefix = comment?.trim() ? `${comment.trim()}\n\n` : "";
    return `${prefix}\`\`\`suggestion\n${suggestion}\n\`\`\``;
}
function ensureSummaryFooter(body, modelId, billing) {
    const hasFooter = body.includes("Reviewed by shitty-reviewing-agent");
    const billingLine = `*Billing: input ${billing.input} • output ${billing.output} • total ${billing.total} • cost $${billing.cost.toFixed(6)}*`;
    const footer = `---\n*Reviewed by shitty-reviewing-agent • model: ${modelId}*\n${billingLine}`;
    if (hasFooter) {
        if (body.includes("Billing: input")) {
            return body;
        }
        return `${body}\n${billingLine}`;
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
