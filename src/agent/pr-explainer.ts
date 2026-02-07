import type { getOctokit } from "@actions/github";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { Usage } from "@mariozechner/pi-ai";
import type { ChangedFile, ExistingComment, PullRequestInfo, ReviewConfig } from "../types.js";
import type { ThinkingLevel } from "./model.js";

type Octokit = ReturnType<typeof getOctokit>;

const BOT_COMMENT_MARKER = "<!-- sri:bot-comment -->";
export const REVIEW_GUIDE_MARKER = "<!-- sri:review-guide -->";
const FILE_GUIDE_MARKER_PREFIX = "<!-- sri:file-review-guide:path=";
const FILE_GUIDE_MARKER_SUFFIX = " -->";

export interface PrExplainerContent {
  reviewGuide: string;
  fileComments: Array<{ path: string; body: string }>;
}

export type PrExplainerGenerateFn = (params: {
  prInfo: PullRequestInfo;
  changedFiles: ChangedFile[];
  sequenceDiagram?: string | null;
}) => Promise<PrExplainerContent | null>;

export async function maybePostPrExplainer(params: {
  enabled: boolean;
  model: any;
  tools: AgentTool<any>[];
  config: ReviewConfig;
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  prInfo: PullRequestInfo;
  changedFiles: ChangedFile[];
  existingComments: ExistingComment[];
  sequenceDiagram?: string | null;
  effectiveThinkingLevel: ThinkingLevel;
  effectiveTemperature?: number;
  log: (...args: unknown[]) => void;
  onBilling?: (usage: Usage) => void;
  generateFn?: PrExplainerGenerateFn;
}): Promise<void> {
  if (!params.enabled || params.changedFiles.length === 0) return;

  const generated = params.generateFn
    ? await params.generateFn({
      prInfo: params.prInfo,
      changedFiles: params.changedFiles,
      sequenceDiagram: params.sequenceDiagram,
    })
    : await generatePrExplainerContent(params);
  if (!generated) {
    params.log("pr explainer produced no usable output");
    return;
  }

  const normalized = normalizePrExplainerContent(generated, params.prInfo, params.changedFiles, params.sequenceDiagram);
  await upsertReviewGuideComment(params, normalized.reviewGuide);
  for (const file of params.changedFiles) {
    const body = normalized.fileCommentByPath.get(file.filename) ?? buildFallbackFileComment(file, params.prInfo);
    await upsertFileGuideComment(params, file, body);
  }
}

async function generatePrExplainerContent(params: {
  model: any;
  tools: AgentTool<any>[];
  config: ReviewConfig;
  prInfo: PullRequestInfo;
  changedFiles: ChangedFile[];
  sequenceDiagram?: string | null;
  effectiveThinkingLevel: ThinkingLevel;
  effectiveTemperature?: number;
  onBilling?: (usage: Usage) => void;
  log: (...args: unknown[]) => void;
}): Promise<PrExplainerContent | null> {
  const agent = new Agent({
    initialState: {
      systemPrompt: buildPrExplainerSystemPrompt(),
      model: params.model,
      tools: params.tools,
      messages: [],
      thinkingLevel: params.effectiveThinkingLevel,
    },
    getApiKey: () => params.config.apiKey,
    streamFn: (modelArg, context, options) =>
      streamSimple(modelArg, context, {
        ...options,
        temperature: params.effectiveTemperature ?? options.temperature,
      }),
  });
  agent.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant" && event.message.usage) {
      params.onBilling?.(event.message.usage);
    }
  });

  try {
    await agent.prompt(
      buildPrExplainerUserPrompt({
        prInfo: params.prInfo,
        changedFiles: params.changedFiles,
        sequenceDiagram: params.sequenceDiagram,
      })
    );
    const text = extractAssistantText(agent.state.messages);
    const parsed = parsePrExplainerJson(text);
    if (!parsed) return null;
    return parsed;
  } catch (error) {
    params.log("pr explainer agent failed", error);
    return null;
  }
}

function buildPrExplainerSystemPrompt(): string {
  return `# Role
You write a PR review guide and per-file explainer comments.

# Constraints
- Use tools to inspect files/diffs before writing.
- Output valid JSON only, no markdown fences or extra text.
- Return exactly this shape:
{
  "reviewGuide": "markdown",
  "fileComments": [
    { "path": "path/from/changed/files", "body": "markdown" }
  ]
}
- Include one fileComments entry for every changed file path.
- Each file comment must include these headings:
  - "What this file does"
  - "What changed"
  - "Why this changed"
  - "Review checklist (high-risk focus)"
- For lower-risk files, keep checklist concise and note low risk.
- Keep content practical and brief; avoid repeating the same sentences across files.`;
}

function buildPrExplainerUserPrompt(params: {
  prInfo: PullRequestInfo;
  changedFiles: ChangedFile[];
  sequenceDiagram?: string | null;
}): string {
  const fileList = params.changedFiles
    .map((file) => `- ${file.filename} (status=${file.status}, +${file.additions}/-${file.deletions})`)
    .join("\n");
  const sequenceSection = params.sequenceDiagram?.trim()
    ? `\n\n# Prebuilt Sequence Diagram\n${params.sequenceDiagram.trim()}\n`
    : "";
  const body = params.prInfo.body?.trim() ? params.prInfo.body.trim() : "(no description)";
  return `# PR Context
Title: ${params.prInfo.title}
Description: ${body}
URL: ${params.prInfo.url}

Changed files:
${fileList}
${sequenceSection}
# Task
Produce a review guide plus one per-file explainer comment using the required JSON format.`;
}

function extractAssistantText(messages: any[]): string {
  const lastAssistant = [...messages].reverse().find((msg) => msg?.role === "assistant");
  if (!lastAssistant) return "";
  const content = lastAssistant.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part?.text === "string")
    .map((part) => part.text)
    .join("");
}

function parsePrExplainerJson(text: string): PrExplainerContent | null {
  const parsed = tryParseFirstObject(text);
  if (!parsed || typeof parsed !== "object") return null;

  const reviewGuide = toStringValue(
    (parsed as any).reviewGuide ?? (parsed as any).review_guide ?? (parsed as any).guide ?? ""
  ).trim();
  const rawFiles = (parsed as any).fileComments ?? (parsed as any).file_comments ?? (parsed as any).files ?? [];
  if (!Array.isArray(rawFiles)) return null;
  const fileComments: Array<{ path: string; body: string }> = [];
  for (const entry of rawFiles) {
    if (!entry || typeof entry !== "object") continue;
    const path = toStringValue((entry as any).path ?? (entry as any).file ?? "").trim();
    const body = toStringValue((entry as any).body ?? (entry as any).comment ?? (entry as any).explanation ?? "").trim();
    if (!path || !body) continue;
    fileComments.push({ path, body });
  }
  if (!reviewGuide && fileComments.length === 0) return null;
  return { reviewGuide, fileComments };
}

function tryParseFirstObject(text: string): any | null {
  if (!text) return null;
  const trimmed = text.trim();
  const candidates: string[] = [];
  const fencedJson = trimmed.match(/```json\s*([\s\S]*?)```/i);
  if (fencedJson?.[1]) candidates.push(fencedJson[1].trim());
  const fenced = trimmed.match(/```\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(trimmed);
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Continue trying looser candidates.
    }
  }
  return null;
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizePrExplainerContent(
  generated: PrExplainerContent,
  prInfo: PullRequestInfo,
  changedFiles: ChangedFile[],
  sequenceDiagram?: string | null
): { reviewGuide: string; fileCommentByPath: Map<string, string> } {
  const changedPathSet = new Set(changedFiles.map((file) => file.filename));
  const map = new Map<string, string>();
  for (const entry of generated.fileComments) {
    const resolved = resolveChangedPath(entry.path, changedPathSet);
    if (!resolved) continue;
    map.set(resolved, entry.body.trim());
  }
  for (const file of changedFiles) {
    if (!map.has(file.filename)) {
      map.set(file.filename, buildFallbackFileComment(file, prInfo));
    }
  }
  const reviewGuide = generated.reviewGuide?.trim()
    ? generated.reviewGuide.trim()
    : buildFallbackReviewGuide(prInfo, changedFiles, sequenceDiagram);
  return { reviewGuide, fileCommentByPath: map };
}

function resolveChangedPath(rawPath: string, changedPathSet: Set<string>): string | null {
  const normalized = rawPath.trim().replace(/^\.?\//, "");
  if (changedPathSet.has(normalized)) return normalized;
  const suffixMatches = [...changedPathSet].filter((path) => path.endsWith(normalized));
  if (suffixMatches.length === 1) return suffixMatches[0];
  return null;
}

function buildFallbackReviewGuide(prInfo: PullRequestInfo, changedFiles: ChangedFile[], sequenceDiagram?: string | null): string {
  const bySize = [...changedFiles]
    .sort((a, b) => b.changes - a.changes)
    .slice(0, 5)
    .map((file) => `- \`${file.filename}\` (+${file.additions}/-${file.deletions})`);
  const sequenceSection = sequenceDiagram?.trim()
    ? `\n\n<details><summary>Sequence diagram</summary>\n\n\`\`\`mermaid\n${sequenceDiagram.trim()}\n\`\`\`\n</details>`
    : "";
  return `## Review Guide

PR: ${prInfo.title}

### Suggested Review Order
${changedFiles.map((file) => `- \`${file.filename}\``).join("\n")}

### Highest-Churn Files
${bySize.length > 0 ? bySize.join("\n") : "- None"}

### Focus Areas
- Confirm behavior changes match the PR description.
- Validate error handling and edge cases on touched paths.
- Check cross-file impacts in shared interfaces and call sites.${sequenceSection}`;
}

function buildFallbackFileComment(file: ChangedFile, prInfo: PullRequestInfo): string {
  return `### What this file does
- This file participates in the codepath affected by this PR; inspect surrounding modules to confirm exact role.

### What changed
- Status: \`${file.status}\`
- Diff stats: +${file.additions} / -${file.deletions}

### Why this changed
- Intended to support the PR goal: "${prInfo.title}". Verify this against the PR description and call sites.

### Review checklist (high-risk focus)
- [ ] Validate behavior on edge cases and failure paths.
- [ ] Confirm callers/consumers are updated if interfaces changed.
- [ ] Check tests cover the new or changed behavior.`;
}

async function upsertReviewGuideComment(
  params: {
    octokit: Octokit;
    owner: string;
    repo: string;
    pullNumber: number;
    existingComments: ExistingComment[];
  },
  guideBody: string
): Promise<void> {
  const body = ensureBotMarker(ensureMarker(guideBody, REVIEW_GUIDE_MARKER));
  const existing = findLatestComment(
    params.existingComments.filter((comment) => comment.type === "issue" && comment.body.includes(REVIEW_GUIDE_MARKER) && isBotComment(comment))
  );
  if (existing) {
    await params.octokit.rest.issues.updateComment({
      owner: params.owner,
      repo: params.repo,
      comment_id: existing.id,
      body,
    });
    return;
  }
  await params.octokit.rest.issues.createComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.pullNumber,
    body,
  });
}

async function upsertFileGuideComment(
  params: {
    octokit: Octokit;
    owner: string;
    repo: string;
    pullNumber: number;
    headSha: string;
    existingComments: ExistingComment[];
    log: (...args: unknown[]) => void;
  },
  file: ChangedFile,
  fileBody: string
): Promise<void> {
  const marker = buildFileGuideMarker(file.filename);
  const body = ensureBotMarker(ensureMarker(fileBody, marker));
  const existing = findLatestComment(
    params.existingComments.filter((comment) => comment.body.includes(marker) && isBotComment(comment))
  );
  if (existing) {
    if (existing.type === "review") {
      await params.octokit.rest.pulls.updateReviewComment({
        owner: params.owner,
        repo: params.repo,
        comment_id: existing.id,
        body,
      });
    } else {
      await params.octokit.rest.issues.updateComment({
        owner: params.owner,
        repo: params.repo,
        comment_id: existing.id,
        body: formatIssueFileBody(file.filename, body),
      });
    }
    return;
  }

  const anchor = findPreferredInlineAnchor(file.patch);
  if (!anchor) {
    await params.octokit.rest.issues.createComment({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.pullNumber,
      body: formatIssueFileBody(file.filename, body),
    });
    return;
  }

  try {
    await params.octokit.rest.pulls.createReviewComment({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pullNumber,
      commit_id: params.headSha,
      path: file.filename,
      line: anchor.line,
      side: anchor.side,
      body,
    });
  } catch (error: any) {
    if (!isLikelyInlineAnchorError(error)) {
      throw error;
    }
    params.log(`pr explainer fallback to issue comment for ${file.filename}`);
    await params.octokit.rest.issues.createComment({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.pullNumber,
      body: formatIssueFileBody(file.filename, body),
    });
  }
}

function ensureMarker(body: string, marker: string): string {
  if (body.includes(marker)) return body;
  const trimmed = body.trim();
  if (!trimmed) return marker;
  return `${trimmed}\n\n${marker}`;
}

function ensureBotMarker(body: string): string {
  if (body.includes(BOT_COMMENT_MARKER)) return body;
  const trimmed = body.trim();
  if (!trimmed) return BOT_COMMENT_MARKER;
  return `${trimmed}\n\n${BOT_COMMENT_MARKER}`;
}

function formatIssueFileBody(path: string, body: string): string {
  return `### File guide: \`${path}\`\n\n${body}`;
}

function isBotComment(comment: ExistingComment): boolean {
  if (comment.authorType?.toLowerCase() === "bot") return true;
  if (comment.author?.toLowerCase().endsWith("[bot]")) return true;
  return comment.body.includes(BOT_COMMENT_MARKER);
}

function findLatestComment(comments: ExistingComment[]): ExistingComment | null {
  if (comments.length === 0) return null;
  return [...comments].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1) ?? null;
}

export function buildFileGuideMarker(path: string): string {
  return `${FILE_GUIDE_MARKER_PREFIX}${encodeURIComponent(path)}${FILE_GUIDE_MARKER_SUFFIX}`;
}

export function findPreferredInlineAnchor(patch?: string): { line: number; side: "LEFT" | "RIGHT" } | null {
  if (!patch) return null;
  const lines = patch.split(/\r?\n/);
  let oldLine = 0;
  let newLine = 0;
  let firstAddedRight: { line: number; side: "RIGHT" } | null = null;
  let firstContextRight: { line: number; side: "RIGHT" } | null = null;
  let firstDeletedLeft: { line: number; side: "LEFT" } | null = null;

  for (const line of lines) {
    const header = line.match(/^@@ -(\d+),?\d* \+(\d+),?\d* @@/);
    if (header) {
      oldLine = Number.parseInt(header[1], 10);
      newLine = Number.parseInt(header[2], 10);
      continue;
    }
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+")) {
      if (!firstAddedRight) {
        firstAddedRight = { line: newLine, side: "RIGHT" };
      }
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      if (!firstDeletedLeft) {
        firstDeletedLeft = { line: oldLine, side: "LEFT" };
      }
      oldLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      if (!firstContextRight) {
        firstContextRight = { line: newLine, side: "RIGHT" };
      }
      oldLine += 1;
      newLine += 1;
    }
  }
  return firstAddedRight ?? firstContextRight ?? firstDeletedLeft ?? null;
}

function isLikelyInlineAnchorError(error: any): boolean {
  const status = error?.status;
  if (status === 400 || status === 404 || status === 422) return true;
  const message = String(error?.message ?? "");
  return /line|side|diff|position|not part of the diff|unprocessable|validation/i.test(message);
}
