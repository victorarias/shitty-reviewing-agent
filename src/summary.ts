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
export type SummaryPlacement = "inline" | "summary_only";

export interface StructuredSummaryFinding {
  findingRef?: string;
  category: SummaryCategory;
  severity: SummarySeverity;
  status: SummaryStatus;
  placement?: SummaryPlacement;
  summaryOnlyReason?: string;
  linkedLocations?: string[];
  title: string;
  details?: string;
  evidence?: string[];
  action?: string;
}

export interface KeyFileSummary {
  path: string;
  whyReview: string;
  whatFileDoes: string;
  whatChanged: string;
  whyChanged: string;
  reviewChecklist: string[];
  impactMap?: string;
}

export interface SummaryObservation {
  category: "context" | "testing" | "risk" | "architecture";
  title: string;
  details?: string;
}

export interface AdaptiveSummaryInput {
  verdict: string;
  preface?: string;
  findings: StructuredSummaryFinding[];
  keyFiles?: KeyFileSummary[];
  observations?: SummaryObservation[];
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

const CATEGORY_DETAIL_LABEL: Record<SummaryCategory, string> = {
  Bug: "Behavior impact",
  Security: "Security risk",
  Performance: "Performance impact",
  "Unused Code": "Maintenance impact",
  "Duplicated Code": "Duplication impact",
  Refactoring: "Refactoring impact",
  Design: "Design impact",
  Documentation: "Documentation impact",
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

export function summaryModeRank(mode: SummaryMode): number {
  return MODE_RANK[mode];
}

export function hasHighRiskFindings(findings: StructuredSummaryFinding[]): boolean {
  return findings.some((finding) => finding.severity === "high" && finding.status !== "resolved");
}

export function buildAdaptiveSummaryMarkdown(input: AdaptiveSummaryInput): string {
  const findings = sanitizeFindings(input.findings);
  const keyFiles = sanitizeKeyFileSummaries(input.keyFiles);
  const observations = sanitizeObservations(input.observations);
  const preface = sanitizeText(input.preface);
  const effectiveMode = hasHighRiskFindings(findings) ? "alert" : input.mode;
  const sections = partitionFindings(findings);

  if (
    input.isFollowUp &&
    sections.newIssues.length === 0 &&
    sections.resolved.length === 0 &&
    sections.stillOpen.length === 0 &&
    observations.length === 0
  ) {
    const message = preface || "No new issues, resolutions, or still-open items to report since the last review.";
    const lines = ["## Review Summary", "", `**Verdict:** ${input.verdict}`, "", message];
    return appendTraceabilityComment(
      lines.join("\n"),
      findings
    );
  }

  if (effectiveMode === "alert") {
    return appendTraceabilityComment(
      renderAlertSummary(
        input.verdict,
        preface,
        findings,
        input.modeReason,
        input.modeEvidence,
        input.isFollowUp ? [] : keyFiles,
        observations
      ),
      findings
    );
  }

  const lines: string[] = ["## Review Summary", "", `**Verdict:** ${input.verdict}`, ""];
  lines.push(preface || defaultPreface(input.isFollowUp, findings.length > 0));
  lines.push("");
  if (!input.isFollowUp) {
    appendKeyFilesSection(lines, keyFiles);
    appendObservationsSection(lines, observations);
  }

  if (!input.isFollowUp) {
    if (findings.length === 0) {
      lines.push("### Findings", "", "- None");
      return appendTraceabilityComment(lines.join("\n"), findings);
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
    return appendTraceabilityComment(lines.join("\n"), findings);
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
  appendObservationsSection(lines, observations);
  return appendTraceabilityComment(lines.join("\n"), findings);
}

function sanitizeFindings(findings: StructuredSummaryFinding[]): StructuredSummaryFinding[] {
  const cleaned: StructuredSummaryFinding[] = [];
  for (const finding of findings) {
    const title = sanitizeText(finding.title);
    if (!title) continue;
    const findingRef = sanitizeFindingRef(finding.findingRef);
    const placement = normalizePlacement(finding.placement);
    const summaryOnlyReason = sanitizeText(finding.summaryOnlyReason) || undefined;
    const linkedLocations = (finding.linkedLocations ?? []).map((item) => sanitizeText(item)).filter(Boolean);
    cleaned.push({
      findingRef,
      category: finding.category,
      severity: finding.severity,
      status: finding.status,
      placement,
      summaryOnlyReason,
      linkedLocations,
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
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeObservationCategory(value: string | undefined): SummaryObservation["category"] {
  if (value === "testing" || value === "risk" || value === "architecture") return value;
  return "context";
}

function sanitizeObservations(value: SummaryObservation[] | undefined): SummaryObservation[] {
  if (!value || value.length === 0) return [];
  const cleaned: SummaryObservation[] = [];
  for (const item of value) {
    const title = sanitizeText(item.title);
    if (!title) continue;
    cleaned.push({
      category: sanitizeObservationCategory(item.category),
      title,
      details: sanitizeText(item.details) || undefined,
    });
  }
  return cleaned.slice(0, 8);
}

function sanitizeFindingRef(value: string | undefined): string | undefined {
  const normalized = sanitizeText(value);
  return normalized || undefined;
}

function normalizePlacement(value: SummaryPlacement | undefined): SummaryPlacement | undefined {
  if (value === "inline" || value === "summary_only") return value;
  return undefined;
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
  modeEvidence?: string[],
  keyFiles?: KeyFileSummary[],
  observations?: SummaryObservation[]
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
  appendKeyFilesSection(lines, keyFiles ?? []);
  appendObservationsSection(lines, observations ?? []);
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
  const displayTitle = deriveDisplayTitle(finding.title, finding.details);
  const linkedTitle = withPrimaryLink(displayTitle, finding.linkedLocations);
  const linkPart = renderFindingLinkage(finding, { verbose, titleLinked: linkedTitle !== displayTitle });
  if (!verbose) {
    const concise = `[${finding.severity}] ${linkedTitle}`;
    return linkPart ? joinSentenceParts([concise, linkPart]) : concise;
  }
  const parts = [`[${finding.severity}] ${linkedTitle}`];
  if (finding.details) {
    parts.push(`${CATEGORY_DETAIL_LABEL[finding.category]}: ${toSingleLine(finding.details)}`);
  }
  if (finding.action) parts.push(`next step: ${toSingleLine(finding.action)}`);
  if (linkPart) parts.push(linkPart);
  return joinSentenceParts(parts);
}

function renderFindingLinkage(
  finding: StructuredSummaryFinding,
  options: { verbose: boolean; titleLinked: boolean }
): string {
  const linked = (finding.linkedLocations ?? []).filter(Boolean);
  if (linked.length > 0) {
    if (options.titleLinked && linked.length === 1) return "";
    if (options.titleLinked) return `inline comments: ${linked.length}`;
    if (!options.verbose && linked.length === 1 && isMarkdownLink(linked[0])) {
      return `inline comment: ${linked[0]}`;
    }
    return options.verbose
      ? `inline comments: ${linked.slice(0, 3).join(", ")}`
      : `inline comments: ${linked.length}`;
  }
  if (finding.placement === "summary_only") {
    if (!options.verbose) return "summary-only";
    if (finding.summaryOnlyReason) return `summary-only scope: ${toSingleLine(finding.summaryOnlyReason)}`;
    return "summary-only scope";
  }
  return "";
}

function deriveDisplayTitle(title: string, details?: string): string {
  const cleanedTitle = toSingleLine(title);
  const isMetaVerificationTitle = /^(verify|validation|check|confirm)\b/i.test(cleanedTitle);
  if (isMetaVerificationTitle && details) {
    return toSingleLine(details);
  }
  return cleanedTitle;
}

function firstSentence(value: string, maxLength: number): string {
  const cleaned = toSingleLine(value);
  const sentenceMatch = cleaned.match(/^(.+?[.?!])(\s|$)/);
  const sentence = sentenceMatch ? sentenceMatch[1] : cleaned;
  if (sentence.length <= maxLength) return sentence;
  return `${sentence.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function toSingleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function joinSentenceParts(parts: string[]): string {
  let result = "";
  for (const part of parts) {
    const cleaned = part.trim();
    if (!cleaned) continue;
    if (!result) {
      result = cleaned;
      continue;
    }
    const normalizedResult = normalizeSentenceBoundary(result);
    const separator = /(?:\.\.\.|…|[.?!:])$/.test(normalizedResult) ? " " : ". ";
    result = `${normalizedResult}${separator}${cleaned}`;
  }
  return result;
}

function normalizeSentenceBoundary(value: string): string {
  return value.replace(/\.\.$/, ".");
}

function appendTraceabilityComment(markdown: string, findings: StructuredSummaryFinding[]): string {
  const block = renderTraceabilityComment(findings);
  if (!block) return markdown;
  return `${markdown}\n\n${block}`;
}

function renderTraceabilityComment(findings: StructuredSummaryFinding[]): string {
  const lines: string[] = [];
  for (const finding of findings) {
    const ref = finding.findingRef?.trim();
    if (!ref) continue;
    const linked = (finding.linkedLocations ?? []).filter(Boolean);
    const placement = finding.placement ?? "inline";
    const reason = finding.summaryOnlyReason ? toSingleLine(firstSentence(finding.summaryOnlyReason, 140)) : "";
    const linkedSummary = linked.length > 0 ? linked.join(" || ") : "none";
    const reasonPart = reason ? `; summary_only_reason=${reason}` : "";
    lines.push(
      `- ref=${escapeHtmlCommentValue(ref)}; category=${escapeHtmlCommentValue(finding.category)}; severity=${escapeHtmlCommentValue(finding.severity)}; status=${escapeHtmlCommentValue(finding.status)}; placement=${escapeHtmlCommentValue(placement)}; linked=${escapeHtmlCommentValue(linkedSummary)}${reasonPart ? `; summary_only_reason=${escapeHtmlCommentValue(reason)}` : ""}`
    );
  }
  if (lines.length === 0) return "";
  return `<!-- sri:traceability\n${lines.join("\n")}\n-->`;
}

function isMarkdownLink(value: string): boolean {
  return /^\[[^\]]+\]\([^)]+\)$/.test(value.trim());
}

function escapeHtmlCommentValue(value: string): string {
  return value.replace(/-->/g, "-- >").replace(/\r?\n/g, " ");
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

function sanitizeKeyFileSummaries(value: KeyFileSummary[] | undefined): KeyFileSummary[] {
  if (!value || value.length === 0) return [];
  const cleaned: KeyFileSummary[] = [];
  for (const item of value) {
    const path = sanitizeText(item.path);
    if (!path) continue;
    const checklist = (item.reviewChecklist ?? [])
      .map((entry) => sanitizeText(entry))
      .filter(Boolean)
      .slice(0, 5);
    cleaned.push({
      path,
      whyReview: sanitizeText(item.whyReview),
      whatFileDoes: sanitizeText(item.whatFileDoes),
      whatChanged: sanitizeText(item.whatChanged),
      whyChanged: sanitizeText(item.whyChanged),
      reviewChecklist: checklist,
      impactMap: sanitizeText(item.impactMap) || undefined,
    });
  }
  return cleaned.slice(0, 8);
}

function appendKeyFilesSection(lines: string[], keyFiles: KeyFileSummary[]): void {
  if (keyFiles.length === 0) return;
  lines.push("### Key Files");
  lines.push("");
  lines.push("| File | Why review this |");
  lines.push("|------|------------------|");
  for (const file of keyFiles) {
    const fileCell = `\`${escapeMarkdownTableCell(file.path)}\``;
    const whyReview = file.whyReview || "n/a";
    lines.push(`| ${fileCell} | ${escapeMarkdownTableCell(whyReview)} |`);
  }
  lines.push("");
  lines.push("<details><summary>📂 File details</summary>");
  lines.push("");
  for (const file of keyFiles) {
    lines.push(`#### \`${file.path}\``);
    lines.push("| Aspect | Notes |");
    lines.push("|-------|-------|");
    lines.push(`| What this file does | ${escapeMarkdownTableCell(file.whatFileDoes || "n/a")} |`);
    lines.push(`| What changed | ${escapeMarkdownTableCell(file.whatChanged || "n/a")} |`);
    lines.push(`| Why it changed | ${escapeMarkdownTableCell(file.whyChanged || "n/a")} |`);
    const checklist = file.reviewChecklist.length > 0
      ? file.reviewChecklist.map((entry) => `- ${entry}`).join("<br>")
      : "n/a";
    lines.push(`| Review checklist | ${escapeMarkdownTableCell(checklist)} |`);
    if (file.impactMap) {
      lines.push(`| Impact map | \`${escapeMarkdownTableCell(file.impactMap)}\` |`);
    }
    lines.push("");
  }
  lines.push("</details>");
  lines.push("");
}

function appendObservationsSection(lines: string[], observations: SummaryObservation[]): void {
  if (observations.length === 0) return;
  lines.push("### Key Findings");
  lines.push("");
  for (const observation of observations) {
    const categoryLabel = observation.category[0].toUpperCase() + observation.category.slice(1);
    const title = toSingleLine(observation.title);
    if (observation.details) {
      lines.push(`- **${title}** (${categoryLabel}): ${toSingleLine(observation.details)}`);
    } else {
      lines.push(`- **${title}** (${categoryLabel})`);
    }
  }
  lines.push("");
}

function withPrimaryLink(title: string, linkedLocations: string[] | undefined): string {
  const primaryUrl = findPrimaryLinkUrl(linkedLocations);
  if (!primaryUrl) return title;
  const escaped = title.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  return `[${escaped}](${primaryUrl})`;
}

function findPrimaryLinkUrl(linkedLocations: string[] | undefined): string | null {
  if (!linkedLocations || linkedLocations.length === 0) return null;
  for (const linked of linkedLocations) {
    const match = linked.match(/^\[[^\]]+\]\(([^)]+)\)$/);
    if (match && match[1]) return match[1];
  }
  return null;
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
