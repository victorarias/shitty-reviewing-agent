export interface SummaryContent {
  verdict: string;
  issues: string[];
  keyFindings: string[];
  multiFileSuggestions: string[];
  model: string;
  reviewSha?: string;
  billing?: {
    input: number;
    output: number;
    total: number;
    cost: number;
  };
}

export const SUMMARY_CATEGORIES = [
  "Bug",
  "Security",
  "Performance",
  "Unused Code",
  "Duplicated Code",
  "Refactoring",
  "Design",
  "Documentation",
] as const;

export type SummaryCategory = (typeof SUMMARY_CATEGORIES)[number];
export type SummarySeverity = "low" | "medium" | "high";
export type SummaryStatus = "new" | "resolved" | "still_open";
export type SummaryMode = "compact" | "standard" | "alert";

export interface StructuredSummaryFinding {
  category: SummaryCategory;
  severity: SummarySeverity;
  status: SummaryStatus;
  title: string;
  details?: string;
  evidence?: string[];
  action?: string;
}

export interface AdaptiveSummaryInput {
  verdict: string;
  preface?: string;
  findings: StructuredSummaryFinding[];
  mode: SummaryMode;
  isFollowUp: boolean;
  modeReason?: string;
  modeEvidence?: string[];
}

const CATEGORY_LOOKUP: Record<string, SummaryCategory> = {
  bug: "Bug",
  security: "Security",
  performance: "Performance",
  "unused code": "Unused Code",
  unused_code: "Unused Code",
  "duplicated code": "Duplicated Code",
  duplicated_code: "Duplicated Code",
  duplication: "Duplicated Code",
  refactoring: "Refactoring",
  design: "Design",
  documentation: "Documentation",
  docs: "Documentation",
};

const MODE_RANK: Record<SummaryMode, number> = {
  compact: 0,
  standard: 1,
  alert: 2,
};

export function buildSummaryMarkdown(content: SummaryContent): string {
  const billing = content.billing
    ? `\n*Billing: input ${content.billing.input} • output ${content.billing.output} • total ${content.billing.total} • cost $${content.billing.cost.toFixed(6)}*`
    : "";
  const botMarker = "\n<!-- sri:bot-comment -->";
  const marker = content.reviewSha ? `\n<!-- sri:last-reviewed-sha:${content.reviewSha} -->` : "";
  const multiFile = renderOptionalSection("Multi-file Suggestions", content.multiFileSuggestions);
  return `## Review Summary\n\n**Verdict:** ${content.verdict}\n\n### Issues Found\n\n${renderList(content.issues)}\n\n### Key Findings\n\n${renderList(content.keyFindings)}\n${multiFile}\n---\n*Reviewed by shitty-reviewing-agent • model: ${content.model}*${billing}${botMarker}${marker}`;
}

function renderList(items: string[]): string {
  if (!items || items.length === 0) {
    return "- None";
  }
  return items.map((item) => `- ${item}`).join("\n");
}

function renderOptionalSection(title: string, items: string[]): string {
  if (!items || items.length === 0 || items.every((item) => item.trim().toLowerCase() === "none")) {
    return "";
  }
  return `\n### ${title}\n\n${renderList(items)}\n`;
}

export function normalizeSummaryCategory(value: string): SummaryCategory | null {
  const normalized = value.trim().toLowerCase();
  return CATEGORY_LOOKUP[normalized] ?? null;
}

export function normalizeSummarySeverity(value: string): SummarySeverity | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") return normalized;
  return null;
}

export function normalizeSummaryStatus(value: string): SummaryStatus | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "new" || normalized === "resolved" || normalized === "still_open") return normalized;
  if (normalized === "still-open" || normalized === "still open" || normalized === "open") return "still_open";
  return null;
}

export function maxSummaryMode(a: SummaryMode, b: SummaryMode): SummaryMode {
  return MODE_RANK[a] >= MODE_RANK[b] ? a : b;
}

export function hasHighRiskFindings(findings: StructuredSummaryFinding[]): boolean {
  return findings.some((finding) => finding.severity === "high" && finding.status !== "resolved");
}

export function buildAdaptiveSummaryMarkdown(input: AdaptiveSummaryInput): string {
  const findings = sanitizeFindings(input.findings);
  const preface = sanitizeText(input.preface);
  const effectiveMode = hasHighRiskFindings(findings) ? "alert" : input.mode;
  const sections = partitionFindings(findings);

  if (input.isFollowUp && sections.newIssues.length === 0 && sections.resolved.length === 0 && sections.stillOpen.length === 0) {
    const message = preface || "No new issues, resolutions, or still-open items to report since the last review.";
    return `## Review Summary\n\n**Verdict:** ${input.verdict}\n\n${message}`;
  }

  if (effectiveMode === "alert") {
    return renderAlertSummary(input.verdict, preface, findings, input.modeReason, input.modeEvidence);
  }

  const lines: string[] = ["## Review Summary", "", `**Verdict:** ${input.verdict}`, ""];
  lines.push(preface || defaultPreface(input.isFollowUp, findings.length > 0));
  lines.push("");

  if (!input.isFollowUp) {
    if (findings.length === 0) {
      lines.push("### Findings", "", "- None");
      return lines.join("\n");
    }
    if (shouldShowCategoryTable(findings, effectiveMode)) {
      lines.push("### Issue Categories");
      lines.push("");
      lines.push("| Category | Count |");
      lines.push("|----------|-------|");
      for (const row of summarizeByCategory(findings)) {
        lines.push(`| ${row.category} | ${row.count} |`);
      }
      lines.push("");
    }
    lines.push("### Findings");
    lines.push("");
    lines.push(renderGroupedFindings(findings, { verbose: effectiveMode === "standard" }));
    return lines.join("\n");
  }

  if (effectiveMode === "standard" && shouldShowFollowUpCategoryTable(findings)) {
    lines.push("### Issue Categories");
    lines.push("");
    lines.push("| Category | Count |");
    lines.push("|----------|-------|");
    for (const row of summarizeByCategory(findings)) {
      lines.push(`| ${row.category} | ${row.count} |`);
    }
    lines.push("");
  }

  lines.push("### New Issues Since Last Review");
  lines.push("");
  lines.push(
    sections.newIssues.length > 0
      ? renderGroupedFindings(sections.newIssues, { verbose: effectiveMode === "standard" })
      : "- None"
  );
  lines.push("");
  lines.push("### Resolved Since Last Review");
  lines.push("");
  lines.push(
    sections.resolved.length > 0
      ? renderGroupedFindings(sections.resolved, { verbose: effectiveMode === "standard" })
      : "- None"
  );
  if (sections.stillOpen.length > 0) {
    lines.push("");
    lines.push("### Still Open");
    lines.push("");
    lines.push(renderGroupedFindings(sections.stillOpen, { verbose: effectiveMode === "standard" }));
  }
  return lines.join("\n");
}

function sanitizeFindings(findings: StructuredSummaryFinding[]): StructuredSummaryFinding[] {
  const cleaned: StructuredSummaryFinding[] = [];
  for (const finding of findings) {
    const title = sanitizeText(finding.title);
    if (!title) continue;
    cleaned.push({
      category: finding.category,
      severity: finding.severity,
      status: finding.status,
      title,
      details: sanitizeText(finding.details),
      action: sanitizeText(finding.action),
      evidence: (finding.evidence ?? []).map((item) => sanitizeText(item)).filter(Boolean),
    });
  }
  return cleaned;
}

function sanitizeText(value: string | undefined): string {
  if (!value) return "";
  return value.replace(/\s+/g, " ").trim();
}

function partitionFindings(findings: StructuredSummaryFinding[]): {
  newIssues: StructuredSummaryFinding[];
  resolved: StructuredSummaryFinding[];
  stillOpen: StructuredSummaryFinding[];
} {
  return {
    newIssues: findings.filter((finding) => finding.status === "new"),
    resolved: findings.filter((finding) => finding.status === "resolved"),
    stillOpen: findings.filter((finding) => finding.status === "still_open"),
  };
}

function renderAlertSummary(
  verdict: string,
  preface: string,
  findings: StructuredSummaryFinding[],
  modeReason?: string,
  modeEvidence?: string[]
): string {
  const risky = findings.filter((finding) => finding.severity === "high" && finding.status !== "resolved");
  const focus = (risky.length > 0 ? risky : findings).slice(0, 3);
  const lines = [
    "## Review Summary",
    "",
    `**Verdict:** ${verdict}`,
    "",
    "**HIGH-RISK CHANGE DETECTED**",
    "",
    preface || "This update has elevated risk and needs focused reviewer attention.",
    "",
    "### Top Risks",
    "",
    focus.length > 0 ? renderGroupedFindings(focus) : "- None",
  ];
  const actions = focus
    .map((finding) => finding.action)
    .filter((value): value is string => Boolean(value))
    .slice(0, 3);
  if (actions.length > 0) {
    lines.push("");
    lines.push("### Required Action");
    lines.push("");
    for (const action of actions) {
      lines.push(`- ${action}`);
    }
  }
  const evidence = [
    ...(modeEvidence ?? []).map((item) => sanitizeText(item)).filter(Boolean),
    ...focus.flatMap((finding) => finding.evidence ?? []),
  ].slice(0, 5);
  if (evidence.length > 0) {
    lines.push("");
    lines.push("### Evidence");
    lines.push("");
    for (const item of evidence) {
      lines.push(`- ${item}`);
    }
  }
  if (sanitizeText(modeReason)) {
    lines.push("");
    lines.push(`Alert rationale: ${sanitizeText(modeReason)}`);
  }
  return lines.join("\n");
}

function shouldShowCategoryTable(findings: StructuredSummaryFinding[], mode: SummaryMode): boolean {
  if (mode !== "standard") return false;
  const categories = summarizeByCategory(findings);
  return findings.length >= 3 || categories.length >= 3;
}

function summarizeByCategory(findings: StructuredSummaryFinding[]): Array<{ category: SummaryCategory; count: number }> {
  const counts = new Map<SummaryCategory, number>();
  for (const category of SUMMARY_CATEGORIES) {
    counts.set(category, 0);
  }
  for (const finding of findings) {
    counts.set(finding.category, (counts.get(finding.category) ?? 0) + 1);
  }
  return SUMMARY_CATEGORIES
    .map((category) => ({ category, count: counts.get(category) ?? 0 }))
    .filter((row) => row.count > 0);
}

function renderGroupedFindings(findings: StructuredSummaryFinding[], options?: { verbose?: boolean }): string {
  if (findings.length === 0) return "- None";
  const verbose = options?.verbose ?? false;
  const lines: string[] = [];
  for (const category of SUMMARY_CATEGORIES) {
    const items = findings.filter((finding) => finding.category === category);
    if (items.length === 0) continue;
    lines.push(`#### ${category} (${items.length})`);
    for (const finding of items) {
      lines.push(`- ${renderFindingLine(finding, verbose)}`);
    }
    lines.push("");
  }
  while (lines.length > 0 && !lines[lines.length - 1]) {
    lines.pop();
  }
  return lines.join("\n");
}

function renderFindingLine(finding: StructuredSummaryFinding, verbose: boolean): string {
  if (!verbose) {
    return `[${finding.severity}] ${finding.title}`;
  }
  const parts = [`[${finding.severity}] ${finding.title}`];
  if (finding.details) parts.push(finding.details);
  if (finding.evidence && finding.evidence.length > 0) {
    parts.push(`evidence: ${finding.evidence.join("; ")}`);
  }
  if (finding.action) parts.push(`action: ${finding.action}`);
  return parts.join(" | ");
}

function shouldShowFollowUpCategoryTable(findings: StructuredSummaryFinding[]): boolean {
  const categories = summarizeByCategory(findings);
  return findings.length >= 3 || categories.length >= 2;
}

function defaultPreface(isFollowUp: boolean, hasFindings: boolean): string {
  if (!hasFindings) {
    return isFollowUp
      ? "No material review findings were identified in this follow-up update."
      : "No material review findings were identified in this pull request.";
  }
  return isFollowUp
    ? "Follow-up review focused on incremental changes since the last review."
    : "Review findings are grouped by category and severity below.";
}
