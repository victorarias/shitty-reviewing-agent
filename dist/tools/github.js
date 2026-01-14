import { Type } from "@sinclair/typebox";
export class RateLimitError extends Error {
    constructor(message) {
        super(message);
        this.name = "RateLimitError";
    }
}
export function createGithubTools(deps) {
    const getPrInfo = {
        name: "get_pr_info",
        label: "Get PR info",
        description: "Get PR title, description, author, base/head branches, and SHAs.",
        parameters: PrInfoSchema,
        execute: async () => {
            if (!deps.cache.prInfo) {
                const response = await safeCall(() => deps.octokit.rest.pulls.get({
                    owner: deps.owner,
                    repo: deps.repo,
                    pull_number: deps.pullNumber,
                }));
                const pr = response.data;
                deps.cache.prInfo = {
                    number: pr.number,
                    title: pr.title ?? "",
                    body: pr.body ?? "",
                    author: pr.user?.login ?? "unknown",
                    baseRef: pr.base?.ref ?? "",
                    headRef: pr.head?.ref ?? "",
                    baseSha: pr.base?.sha ?? "",
                    headSha: pr.head?.sha ?? "",
                    url: pr.html_url ?? "",
                };
            }
            return {
                content: [{ type: "text", text: JSON.stringify(deps.cache.prInfo, null, 2) }],
                details: deps.cache.prInfo,
            };
        },
    };
    const getChangedFiles = {
        name: "get_changed_files",
        label: "Get changed files",
        description: "List files changed in the PR (path + status).",
        parameters: ChangedFilesSchema,
        execute: async () => {
            if (!deps.cache.changedFiles) {
                const files = await safeCall(() => deps.octokit.paginate(deps.octokit.rest.pulls.listFiles, {
                    owner: deps.owner,
                    repo: deps.repo,
                    pull_number: deps.pullNumber,
                    per_page: 100,
                }));
                deps.cache.changedFiles = files.map((file) => ({
                    filename: file.filename,
                    status: file.status,
                    additions: file.additions ?? 0,
                    deletions: file.deletions ?? 0,
                    changes: file.changes ?? 0,
                    patch: file.patch,
                    previous_filename: file.previous_filename,
                }));
            }
            return {
                content: [{ type: "text", text: JSON.stringify(deps.cache.changedFiles, null, 2) }],
                details: { files: deps.cache.changedFiles },
            };
        },
    };
    const getDiff = {
        name: "get_diff",
        label: "Get diff",
        description: "Get diff for a specific file in the PR.",
        parameters: DiffSchema,
        execute: async (_id, params) => {
            if (!deps.cache.changedFiles) {
                const files = await safeCall(() => deps.octokit.paginate(deps.octokit.rest.pulls.listFiles, {
                    owner: deps.owner,
                    repo: deps.repo,
                    pull_number: deps.pullNumber,
                    per_page: 100,
                }));
                deps.cache.changedFiles = files.map((file) => ({
                    filename: file.filename,
                    status: file.status,
                    additions: file.additions ?? 0,
                    deletions: file.deletions ?? 0,
                    changes: file.changes ?? 0,
                    patch: file.patch,
                    previous_filename: file.previous_filename,
                }));
            }
            const match = deps.cache.changedFiles.find((file) => file.filename === params.path);
            const patch = match?.patch;
            const text = patch ? patch : "(no diff available - possibly binary or too large)";
            return {
                content: [{ type: "text", text }],
                details: { path: params.path, patch },
            };
        },
    };
    return [getPrInfo, getChangedFiles, getDiff];
}
const PrInfoSchema = Type.Object({});
const ChangedFilesSchema = Type.Object({});
const DiffSchema = Type.Object({
    path: Type.String({ description: "File path relative to repo root" }),
});
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
