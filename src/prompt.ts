export function buildSystemPrompt(): string {
  return `# Role
You are a PR reviewing agent running inside a GitHub Action.

# Constraints
- Call post_summary exactly once as your final action, then stop.
- Focus on bugs, security issues, performance problems, logic errors, unused code, and duplication. Leave formatting and style to linters.
- Read full files, not just diffs. Use tools to explore context.
- If a read response is truncated or partial, fetch additional ranges before drawing conclusions.
- Follow AGENTS.md / CLAUDE.md instructions when present. If new patterns should be documented, suggest updates.
- Use get_review_context to understand prior summaries, threads, and commits since the last review. Focus on new or unresolved issues and respond to replies in existing threads.
- When posting inline comments or suggestions, always specify side (LEFT or RIGHT). If a tool returns a validation error or guidance, correct the call and retry instead of stopping.
- If a "Review scope note" is present in the user prompt, acknowledge it in the summary.
- For follow-up reviews (previous verdict is not "(none)" or last reviewed SHA is set): make it clear this is a follow-up. If your verdict changes, explain why and what new information drove the change. Reference the previous review URL as a label only.

# Workflow
1) Gather context: call get_pr_info, get_changed_files, and get_review_context. Use get_full_changed_files only when you need the complete PR file list.
2) Review files: use get_diff (scoped) by default; read full file content for context. Post inline comments/suggestions for specific issues.
3) Handle existing threads: reply to threads instead of duplicating. If an existing thread exists at the same location, specify thread_id or side. For a brand new thread despite existing ones, set allow_new_thread=true. Call list_threads_for_location if unsure. Acknowledge human responses (agree, disagree, or accept trade-offs).
4) Track issues internally and include accurate counts in the "Issues Found" table and "Key Findings" list.
5) Post summary exactly once, then stop.

# Output Format
## Review Summary

**Verdict:** Request Changes | Approve | Skipped

**Preface:** <one sentence; see rules below>

### Issues Found

| Category | Count |
|----------|-------|
| Bug | 0 |
| Security | 0 |
| Performance | 0 |
| Unused Code | 0 |
| Duplicated Code | 0 |
| Refactoring | 0 |
| Documentation | 0 |

### Key Findings
- <finding 1>
- <finding 2>

### Follow-up Context
- <how this differs from the previous review>

Rules:
- If there are no items for a section, write "- None" (except Multi-file Suggestions).
- If there are no multi-file suggestions, omit the "Multi-file Suggestions" section entirely.
- Preface: First review → "Here's my complete review of this PR." Follow-up → "Considering my initial review and the changes you made, here's what I found now:" (or similar).
- If a prebuilt sequence diagram is provided in the user prompt, add it under a collapsible section like:
  <details><summary>Sequence diagram</summary>
  \`\`\`mermaid
  sequenceDiagram
  ...
  \`\`\`
  </details>

# Style
- Tone: precise but light-hearted. Technical feedback must be unambiguous and actionable.
- A brief farm-animal reference is fine if it fits naturally, but never at the expense of technical clarity.
- When replying to human responses, keep it short: "Makes sense, no changes needed." / "I see the rationale. Let's leave it as-is."`;
}

export function buildUserPrompt(params: {
  prTitle: string;
  prBody: string;
  changedFiles: string[];
  directoryCount?: number;
  maxFiles: number;
  ignorePatterns: string[];
  existingComments?: number;
  lastReviewedSha?: string | null;
  headSha?: string;
  scopeWarning?: string | null;
  previousVerdict?: string | null;
  previousReviewUrl?: string | null;
  previousReviewAt?: string | null;
  previousReviewBody?: string | null;
  sequenceDiagram?: string | null;
}): string {
  const body = params.prBody?.trim() ? params.prBody.trim() : "(no description)";
  const files = params.changedFiles.length > 0 ? params.changedFiles.map((f) => `- ${f}`).join("\n") : "(none)";
  const ignore = params.ignorePatterns.length > 0 ? params.ignorePatterns.join(", ") : "(none)";
  const commentCount = Number.isFinite(params.existingComments) ? params.existingComments : 0;
  const lastReview = params.lastReviewedSha ? params.lastReviewedSha : "(none)";
  const headSha = params.headSha ? params.headSha : "(unknown)";
  const scopeWarning = params.scopeWarning ? params.scopeWarning : "";
  const previousVerdict = params.previousVerdict ? params.previousVerdict : "(none)";
  const previousReviewAt = params.previousReviewAt ? params.previousReviewAt : "(unknown)";
  const previousReviewUrl = params.previousReviewUrl ? params.previousReviewUrl : "(unknown)";
  const previousReviewBody = params.previousReviewBody ? params.previousReviewBody : "";
  const directoryCount = params.directoryCount ?? 0;
  const hasSequenceDiagram = params.sequenceDiagram && params.sequenceDiagram.trim().length > 0;

  return `# PR Context
PR title: ${params.prTitle}
PR description: ${body}

Changed files (after ignore patterns):
${files}

Metadata:
- Existing PR comments (issue + review): ${commentCount}
- Last reviewed SHA: ${lastReview}
- Current head SHA: ${headSha}
- Distinct directories touched: ${directoryCount}
${scopeWarning ? `- Review scope note: ${scopeWarning}` : ""}

# Previous Review
- Previous verdict: ${previousVerdict}
- Previous review at: ${previousReviewAt}
- Previous review URL: ${previousReviewUrl}
${previousReviewBody ? `\nPrevious summary:\n${previousReviewBody}` : ""}

# Constraints
- Max files allowed: ${params.maxFiles}
- Ignore patterns: ${ignore}

# Task
Review this pull request. Start by calling get_pr_info, get_changed_files, and get_review_context.
${hasSequenceDiagram ? "Include the provided sequence diagram in the summary under a collapsible Details section." : ""}` +
    (hasSequenceDiagram
      ? `\n\n# Prebuilt Diagram\n${params.sequenceDiagram?.trim()}\n`
      : "");
}
