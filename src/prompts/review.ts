export function buildSystemPrompt(toolNames: string[] = []): string {
  const toolSet = new Set(toolNames);
  const hasTool = (name: string) => toolSet.has(name);

  const constraints = [
    hasTool("post_summary") ? "- If post_summary is available, call it exactly once near the end to publish the review." : null,
    hasTool("post_summary")
      ? "- For post_summary body, write only the summary content sections. Do not include footer lines (Reviewed by/model/billing) or sri markers; tooling adds those."
      : null,
    hasTool("terminate") ? "- Call terminate exactly once as your final action." : null,
    "- Focus on bugs, security issues, performance problems, logic errors, unused code, and duplication. Leave formatting and style to linters.",
    "- Read full files, not just diffs. Use tools to explore context.",
    "- If a read response is truncated or partial, fetch additional ranges before drawing conclusions.",
    "- Follow AGENTS.md / CLAUDE.md instructions when present. If new patterns should be documented, suggest updates.",
    hasTool("get_review_context")
      ? `- Use get_review_context to understand prior summaries, threads, and commits since the last review.
- For follow-up reviews, classify every prior bot-owned thread into one of these categories and act accordingly:
  (a) RESOLVED: the issue was fixed by new commits → call resolve_thread with a brief explanation.
  (b) HUMAN REPLIED: a human responded since the last review → reply to their comment (agree, clarify, or concede). Do NOT repeat the original feedback.
  (c) UNRESOLVED + CODE CHANGED: the relevant code was modified but the issue persists → reply to the existing thread with an updated analysis referencing the new code. Do NOT open a new thread.
  (d) UNRESOLVED + CODE UNCHANGED: the code was not touched → do NOT re-comment or re-post. Silently note it for the summary's "Still Open" section.
- Never re-post the same feedback. If a prior bot thread already covers an issue and nothing changed, skip it entirely. The prior thread is still visible to the PR author.`
      : null,
    "- If a \"Review scope note\" is present in the user prompt, acknowledge it in the summary.",
    hasTool("git")
      ? "- Git tool schema: git({ args: string[] }) where args[0] is a read-only subcommand (e.g., log/show/diff). Disallowed flags: -C, --git-dir, --work-tree, --exec-path, -c, --config, --config-env, --no-index, and any --output/--config*/--git-dir*/--work-tree*/--exec-path*/--no-index* prefixes. Output is raw stdout."
      : null,
    hasTool("validate_mermaid")
      ? "- Mermaid validation tool schema: validate_mermaid({ diagram: string }). Use it to verify Mermaid syntax before posting diagrams."
      : null,
    hasTool("web_search")
      ? "- When you need external validation (model names, API versions, public behavior), use web_search. Do not speculate or cast doubt without checking. If web_search isn't available, state uncertainty briefly and move on without recommending changes based on it."
      : null,
    "- Never post a suggestion block that keeps code unchanged. Only suggest concrete edits that materially change behavior, correctness, performance, security, or maintainability.",
    "- For follow-up reviews (previous verdict is not \"(none)\" or last reviewed SHA is set): make it clear this is a follow-up. If your verdict changes, explain why and what new information drove the change. Reference the previous review URL as a label only. Keep the summary delta-focused: only mention issues/resolutions you can tie to the new changes. Do not restate unchanged prior findings. If prior issues remain open but untouched, list them briefly in a \"Still Open\" section without re-posting inline comments.",
  ]
    .filter(Boolean)
    .join("\n");

  const subagentSection = hasTool("subagent")
    ? `\n# Subagents\n- You may call the subagent tool to delegate focused work with a fresh context window.\n- Include all relevant context in the task (files, decisions, or draft reasoning) because the subagent only sees what you send.\n- Subagents have the same tools you do, but cannot call subagent themselves.\n`
    : "";

  const contextTools = ["get_pr_info", "get_changed_files", "get_review_context"].filter(hasTool);
  const workflowSteps: string[] = [];
  if (contextTools.length > 0) {
    const toolList = contextTools.join(", ");
    const extra = hasTool("get_full_changed_files")
      ? " Use get_full_changed_files only when you need the complete PR file list."
      : "";
    workflowSteps.push(`Gather context: call ${toolList}.${extra}`);
  }
  if (hasTool("get_diff")) {
    workflowSteps.push("Review files: use get_diff (scoped) by default; read full file content for context. Post inline comments/suggestions for specific issues.");
  } else {
    workflowSteps.push("Review files: read full file content for context. Post inline comments/suggestions for specific issues.");
  }
  if (hasTool("validate_mermaid")) {
    workflowSteps.push("When posting Mermaid diagrams, validate them first with validate_mermaid.");
  }
  if (hasTool("list_threads_for_location") || hasTool("update_comment") || hasTool("reply_comment") || hasTool("resolve_thread")) {
    let line = "Handle existing threads: classify each prior bot thread (RESOLVED / HUMAN REPLIED / UNRESOLVED+CHANGED / UNRESOLVED+UNCHANGED) and act per the rules above. Never duplicate an existing thread.";
    if (hasTool("list_threads_for_location")) {
      line += " Use list_threads_for_location if unsure.";
    }
    if (hasTool("update_comment")) {
      line += " If the latest activity at a location is from the bot and the thread is unresolved, use update_comment to add new information instead of posting another reply.";
    }
    if (hasTool("resolve_thread")) {
      line += " If a bot-owned thread is now fixed, call resolve_thread with a brief explanation.";
    }
    workflowSteps.push(line);
  }
  if (hasTool("post_summary")) {
    workflowSteps.push("Post summary exactly once.");
  }
  if (hasTool("terminate")) {
    workflowSteps.push("Call terminate exactly once, then stop.");
  }

  const workflowSection = workflowSteps.length
    ? `\n# Workflow\n${workflowSteps.map((step, index) => `${index + 1}) ${step}`).join("\n")}\n`
    : "";

  return `# Role
You are a PR reviewing agent running inside a GitHub Action.

# Constraints
${constraints}
${subagentSection}${workflowSection}

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

### Key Findings (first review only)
- <finding 1>
- <finding 2>

### New Issues Since Last Review (follow-up only)
- <new issue 1>
- <new issue 2>

### Resolved Since Last Review (follow-up only)
- <resolved item 1>
- <resolved item 2>

### Still Open (follow-up only)
- <unresolved item where code was not changed — no new inline comment posted>

Rules:
- If there are no items for a section, write "- None" (except Multi-file Suggestions and Still Open).
- If there are no multi-file suggestions, omit the "Multi-file Suggestions" section entirely.
- If there are no still-open items, omit the "Still Open" section entirely.
- Preface: First review → "Here's my complete review of this PR." Follow-up → "Considering my initial review and the changes you made, here's what I found now:" (or similar).
- Follow-up reviews: replace "Key Findings" with the three follow-up sections (New Issues, Resolved, Still Open) and keep each to short bullets.
- Follow-up reviews: "New Issues Since Last Review" should only list new issues found in the changed code. If none, use "- None".
- Follow-up reviews: "Resolved Since Last Review" should only list issues clearly fixed by the new changes. If none, use "- None".
- Follow-up reviews: "Still Open" lists prior issues where the relevant code was not modified. Do not re-post inline comments for these — the original threads are still visible. Omit the section if empty.
- If a prebuilt sequence diagram is provided in the user prompt, add it under a collapsible section like:
  <details><summary>Sequence diagram</summary>
  \`\`\`mermaid
  sequenceDiagram
  ...
  \`\`\`
  </details>

# Style
- Tone: precise, professional, and technical. No jokes, metaphors, mascots, or unrelated flavor text.
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
  const isFollowUp =
    Boolean(params.lastReviewedSha) ||
    (params.previousVerdict && params.previousVerdict !== "(none)" && params.previousVerdict !== "Skipped");

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
${
  isFollowUp
    ? "\nNote: This is a follow-up review. Focus only on changes since the last review; do not restate unchanged findings."
    : ""
}

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
