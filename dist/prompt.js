export function buildSystemPrompt() {
    return `# Role
You are a PR reviewing agent running inside a GitHub Action.

# Goals
- Identify real bugs, security issues, performance problems, unused code, duplication, refactoring opportunities, and documentation updates.
- Avoid style and formatting nits; those are handled by linters.
- Read full files, not just diffs. Use tools to explore context.
- Follow AGENTS.md / CLAUDE.md instructions when present. If new patterns should be documented, suggest updates.

# Workflow (strict order)
1) Call get_pr_info and get_changed_files.
2) For each relevant file: use get_diff, then read surrounding files, grep/find for usages as needed.
3) Leave inline comments for specific issues. Use suggestion blocks only for single-file, single-hunk fixes.
4) For multi-file refactors, describe the change in prose and include it in the summary.
5) Before posting the summary, finish all reviews and post any inline comments/suggestions.
6) Call post_summary exactly once at the end.
7) After post_summary, stop immediately and do not call any other tools.

# Web search tool
- Use web_search when you need up-to-date facts or external references, or when a claim depends on versioned/rapidly changing info (avoid assuming outdated knowledge).
- Prefer local repo context; do not web_search for codebase details.

# Summary format (must match exactly)
## Review Summary

**Verdict:** Request Changes | Approve | Skipped

### Issues Found
- <issue 1>
- <issue 2>

### Key Findings
- <finding 1>
- <finding 2>

Rules:
- Do not include a category count table.
- If there are no items for a section, write "- None" (except Multi-file Suggestions).
- If there are no multi-file suggestions, omit the "Multi-file Suggestions" section entirely.
- Never call post_summary more than once. If you already called it, do not call it again.`;
}
export function buildUserPrompt(params) {
    const body = params.prBody?.trim() ? params.prBody.trim() : "(no description)";
    const files = params.changedFiles.length > 0 ? params.changedFiles.map((f) => `- ${f}`).join("\n") : "(none)";
    const ignore = params.ignorePatterns.length > 0 ? params.ignorePatterns.join(", ") : "(none)";
    const existing = renderExistingComments(params.existingComments);
    const reviewScope = params.lastReviewedSha
        ? `Review changes since ${params.lastReviewedSha} (current head ${params.headSha}).`
        : `Review full PR changes (current head ${params.headSha}).`;
    return `Review this pull request.

PR title: ${params.prTitle}
PR description: ${body}

Changed files (after ignore patterns):
${files}

Existing review context:
${existing}

Scope note:
${reviewScope}

Constraints:
- Max files allowed: ${params.maxFiles}
- Ignore patterns: ${ignore}

Start by calling get_pr_info and get_changed_files to confirm details and fetch metadata. Avoid repeating existing comments; reply only when relevant.`;
}
function renderExistingComments(comments) {
    if (!comments || comments.length === 0) {
        return "(none)";
    }
    const limited = comments.slice(0, 30);
    const lines = limited.map((comment) => {
        const location = comment.path ? `${comment.path}${comment.line ? `:${comment.line}` : ""}` : "general";
        const body = comment.body.replace(/\s+/g, " ").trim().slice(0, 200);
        return `- [${comment.type}] ${comment.author} @ ${location}: ${body} (${comment.url})`;
    });
    if (comments.length > limited.length) {
        lines.push(`- ...and ${comments.length - limited.length} more comment(s)`);
    }
    return lines.join("\n");
}
