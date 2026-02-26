// Per-tool documentation strings. Auto-included in the "Tool Notes" section
// when the tool is present — no need to add hasTool() checks elsewhere.
const TOOL_DOCS: Record<string, string> = {
  post_summary:
    "call exactly once near the end. Prefer verdict/preface with recorded findings; footer (model/billing/markers) is added automatically.",
  report_finding:
    "`report_finding({ category, severity, status, title, details?, evidence?, action? })` — record every finding for deterministic rendering.",
  set_summary_mode:
    "`set_summary_mode({ mode, reason, evidence[] })` — escalate summary mode to standard/alert when risk justifies it. Never use for downgrades.",
  terminate: "call exactly once as your final action.",
  git: "`git({ args: string[] })` — read-only subcommands only (log/show/diff). Blocked flags: -C, --git-dir, --work-tree, --exec-path, -c, --config, --config-env, --no-index.",
  validate_mermaid: "`validate_mermaid({ diagram: string })` — validate Mermaid syntax before posting.",
};

export function buildSystemPrompt(toolNames: string[] = []): string {
  const toolSet = new Set(toolNames);
  const hasTool = (name: string) => toolSet.has(name);

  // --- Capabilities (derived from available tools) ---
  // These replace the many individual hasTool() checks scattered through the
  // prompt. Each flag maps to a coherent behaviour rather than a single tool,
  // so prompt sections can't reference content that was never rendered.
  const can = {
    followUp: hasTool("get_review_context"),
    manageThreads: ["list_threads_for_location", "update_comment", "reply_comment", "resolve_thread"].some(hasTool),
    searchWeb: hasTool("web_search"),
    useSubagent: hasTool("subagent"),
    postSummary: hasTool("post_summary"),
    reportFinding: hasTool("report_finding"),
    setSummaryMode: hasTool("set_summary_mode"),
    terminate: hasTool("terminate"),
    useDiff: hasTool("get_diff"),
    validateMermaid: hasTool("validate_mermaid"),
  };

  // --- What to review ---
  const reviewFocus = [
    "- Bugs, security vulnerabilities, logic errors, and performance problems.",
    "- Unused code and duplication.",
    "- Software design: flag complexity leaks, shallow abstractions that add boilerplate without hiding information, unclear or overly broad interfaces, poor separation of concerns, and tight coupling. Think like Ousterhout (*A Philosophy of Software Design*) and Farley (*Modern Software Engineering*). Suggest concrete structural improvements, not vague advice.",
    "- Leave formatting and style to linters.",
  ].join("\n");

  // --- How to review ---
  const howToReview = [
    "- Read full files for context, not just diffs. If a read is truncated, fetch remaining ranges before concluding.",
    "- Follow AGENTS.md / CLAUDE.md when present. Suggest updates if new patterns should be documented.",
    "- Only post suggestions that materially change behavior, correctness, performance, security, design, or maintainability. Never post a no-op suggestion block.",
    can.searchWeb
      ? "- Use web_search to validate external facts (API versions, public behavior). Do not speculate without checking."
      : null,
    '- If a "Review scope note" is present in the user prompt, acknowledge it in the summary.',
  ]
    .filter(Boolean)
    .join("\n");

  // --- Follow-up reviews (only when review context is available) ---
  const resolvedAction = hasTool("resolve_thread")
    ? "`resolve_thread` with brief explanation"
    : 'Note as resolved in summary "Resolved Since Last Review" section';
  const followUpSection = can.followUp
    ? `\n# Follow-up Reviews
Call get_review_context first. Use both reviewThreads and issueCommentReplies. When a previous review exists, classify every prior bot-owned thread and PR-level reply:

| Case | Condition | Action |
|------|-----------|--------|
| RESOLVED | Fixed by new commits | ${resolvedAction} |
| HUMAN REPLIED (THREAD) | Human responded in a review thread | Reply to their comment — do not repeat the original feedback |
| HUMAN REPLIED (PR COMMENT) | Human responded in issueCommentReplies (outside review threads) | Acknowledge their rationale in the next summary; do not ignore or restate unchanged feedback |
| CODE CHANGED | Code modified, issue persists | Reply to existing thread with updated analysis — do not open a new one |
| UNCHANGED | Code not touched | Do nothing inline — list in summary "Still Open" section only |

Never re-post feedback that a prior thread already covers. If the verdict changes, explain what new information drove it. Reference the previous review URL as a label only.
`
    : "";

  // --- Tool notes (auto-generated from TOOL_DOCS registry) ---
  const toolNotes = toolNames.filter((name) => TOOL_DOCS[name]).map((name) => `- **${name}**: ${TOOL_DOCS[name]}`);

  const toolNotesSection = toolNotes.length > 0 ? `\n# Tool Notes\n${toolNotes.join("\n")}\n` : "";

  // --- Subagents ---
  const subagentSection = can.useSubagent
    ? `\n# Subagents\n- Delegate focused work with a fresh context window. Include all relevant context — the subagent only sees what you send.\n- Subagents have the same tools but cannot call subagent themselves.\n`
    : "";

  // --- Workflow ---
  const contextTools = ["get_pr_info", "get_changed_files", "get_review_context"].filter(hasTool);
  const workflowSteps: string[] = [];
  if (contextTools.length > 0) {
    const toolList = contextTools.join(", ");
    const extra = hasTool("get_full_changed_files")
      ? " (use get_full_changed_files only when you need the unscoped file list)"
      : "";
    workflowSteps.push(`Gather context: call ${toolList}${extra}.`);
  }
  if (can.useDiff) {
    workflowSteps.push(
      "Review files: use get_diff for targeted diffs; read full files for surrounding context. Post inline comments/suggestions for specific issues."
    );
  } else {
    workflowSteps.push("Review files: read full file content for context. Post inline comments/suggestions for specific issues.");
  }
  if (can.validateMermaid) {
    workflowSteps.push("Validate Mermaid diagrams with validate_mermaid before posting.");
  }
  // Thread management — only emitted when followUp provides the classification
  // table. Without it, "per the classification above" would be a dangling ref.
  if (can.followUp && can.manageThreads) {
    const parts = ["Handle existing threads per the classification above."];
    if (hasTool("list_threads_for_location")) parts.push("Use list_threads_for_location when unsure.");
    if (hasTool("update_comment"))
      parts.push("Use update_comment if the latest activity at a location is from the bot and the thread is unresolved.");
    if (hasTool("resolve_thread")) parts.push("Use resolve_thread for fixed bot-owned threads.");
    workflowSteps.push(parts.join(" "));
  }
  if (can.reportFinding) {
    workflowSteps.push("Record each issue/resolution/still-open item with report_finding before posting summary.");
  }
  if (can.setSummaryMode) {
    workflowSteps.push("Use set_summary_mode only when evidence shows higher risk than the default summary mode.");
  }
  if (can.postSummary) workflowSteps.push("Post summary exactly once.");
  if (can.terminate) workflowSteps.push("Call terminate, then stop.");

  const workflowSection = workflowSteps.length
    ? `\n# Workflow\n${workflowSteps.map((step, i) => `${i + 1}. ${step}`).join("\n")}\n`
    : "";
  const summaryFindingRecording = can.reportFinding
    ? "Use report_finding for every issue/resolution/still-open item. Each finding must include category + severity + status."
    : "List each finding with category, severity, and status (new/resolved/still-open).";
  const summaryModeBehavior = can.setSummaryMode
    ? "- Use set_summary_mode only to escalate when evidence warrants it (never downgrade below candidate)."
    : "- If risk is clearly high, increase signal in the summary and make required action explicit.";
  const summaryPostUsage = can.postSummary
    ? `post_summary usage:
- Preferred: call post_summary with verdict + preface only; tooling renders markdown from findings.
- Legacy fallback: if you provide post_summary.body directly, keep it concise and do not add footer/markers.`
    : "";

  return `# Role
You are a PR reviewing agent running inside a GitHub Action.

# What to Review
${reviewFocus}

# How to Review
${howToReview}
${followUpSection}${toolNotesSection}${subagentSection}${workflowSection}
# Summary Format

## Review Summary

**Verdict:** Request Changes | Approve | Skipped

<one-sentence preface grounded in PR specifics — no label prefix, no generic filler>

### Findings by Category
${summaryFindingRecording}

Allowed categories:
- bug, security, performance, unused_code, duplicated_code, refactoring, design, documentation

Allowed statuses:
- new, resolved, still_open

Follow-up summaries are rendered into:
- New Issues Since Last Review
- Resolved Since Last Review
- Still Open (omit when empty)

Rendering is deterministic in tooling:
- If 1-2 findings, skip category table.
- If findings are sparse/empty, omit empty sections.
- If follow-up has no new/resolved/still-open items, tooling posts a short status summary.
- If risk is high, tooling switches to alert mode and makes risk signal explicit.

Summary mode behavior:
- User prompt provides a deterministic summary mode candidate (compact or standard) and risk hints.
${summaryModeBehavior}
- Alert mode requires evidence (file/line, thread, or concrete risk rationale).

${summaryPostUsage}

# Style
- Precise, professional, technical. No jokes, metaphors, or filler.
- Replies to humans: keep short. "Makes sense, no changes needed." / "I see the rationale."`;
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
  changedLineCount?: number;
  summaryModeCandidate?: "compact" | "standard";
  riskHints?: string[];
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
  const changedLineCount = Number.isFinite(params.changedLineCount) ? Math.max(0, Math.trunc(params.changedLineCount as number)) : "(unknown)";
  const summaryModeCandidate = params.summaryModeCandidate ?? "standard";
  const riskHints = params.riskHints && params.riskHints.length > 0 ? params.riskHints.map((hint) => `  - ${hint}`).join("\n") : "  - None";
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
- Scoped delta after ignore: ${params.changedFiles.length} file(s), ${changedLineCount} changed line(s)
- Deterministic summary mode candidate: ${summaryModeCandidate}
- Deterministic risk hints:
${riskHints}
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
${isFollowUp ? "\nNote: For follow-ups, you may call set_summary_mode only to escalate above the candidate mode when evidence justifies it." : ""}

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
