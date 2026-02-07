import type { getOctokit } from "@actions/github";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { Usage } from "@mariozechner/pi-ai";
import { isGeneratedPath } from "./file-filters.js";
import { validateMermaidDiagram } from "../tools/fs.js";
import type { ChangedFile, ExistingComment, PullRequestInfo, ReviewConfig } from "../types.js";
import type { ThinkingLevel } from "./model.js";

type Octokit = ReturnType<typeof getOctokit>;

const BOT_COMMENT_MARKER = "<!-- sri:bot-comment -->";
export const REVIEW_GUIDE_MARKER = "<!-- sri:review-guide -->";
export const REVIEW_GUIDE_FAILURE_MARKER = "<!-- sri:review-guide-error -->";
const FILE_GUIDE_MARKER_PREFIX = "<!-- sri:file-review-guide:path=";
const FILE_GUIDE_MARKER_SUFFIX = " -->";

export interface PrExplainerContent {
  reviewGuide: string;
  fileComments: Array<{ path: string; body: string }>;
}

export type PrExplainerGenerateFn = (params: {
  prInfo: PullRequestInfo;
  changedFiles: ChangedFile[];
  eligibleFiles: ChangedFile[];
  requireDiagrams: boolean;
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
  requireDiagrams?: boolean;
}): Promise<void> {
  if (!params.enabled || params.changedFiles.length === 0) return;
  const { eligibleFiles, skippedFiles } = await selectEligibleFilesForExplainer(params.changedFiles, params.config.repoRoot);
  if (skippedFiles.length > 0) {
    params.log(
      "pr explainer skipped files",
      skippedFiles.map((entry) => `${entry.file}:${entry.reason}`).join(", ")
    );
  }

  const generated = params.generateFn
    ? await params.generateFn({
      prInfo: params.prInfo,
      changedFiles: params.changedFiles,
      eligibleFiles,
      requireDiagrams: Boolean(params.requireDiagrams),
      sequenceDiagram: params.sequenceDiagram,
    })
    : await generatePrExplainerContent({
      ...params,
      eligibleFiles,
    });
  if (!generated) {
    await upsertExplainerFailureComment(params, [
      "Explainer output was missing or could not be parsed as required JSON.",
    ]);
    return;
  }

  const normalized = normalizePrExplainerContent(generated, eligibleFiles);
  if (normalized.unresolvedPaths.length > 0) {
    params.log(
      "pr explainer ignored unknown file comment paths",
      normalized.unresolvedPaths.join(", ")
    );
  }
  if (!normalized.reviewGuide && normalized.fileCommentByPath.size === 0) {
    params.log("pr explainer produced no usable content");
    return;
  }

  const diagramValidation = await validateReviewGuideDiagrams(normalized.reviewGuide, Boolean(params.requireDiagrams));
  if (!diagramValidation.ok) {
    await upsertExplainerFailureComment(params, diagramValidation.errors);
    return;
  }

  if (normalized.reviewGuide) {
    await upsertReviewGuideComment(params, normalized.reviewGuide);
  }
  for (const file of eligibleFiles) {
    const body = normalized.fileCommentByPath.get(file.filename);
    if (!body) continue;
    await upsertFileGuideComment(params, file, body);
  }
}

async function generatePrExplainerContent(params: {
  model: any;
  tools: AgentTool<any>[];
  config: ReviewConfig;
  prInfo: PullRequestInfo;
  changedFiles: ChangedFile[];
  eligibleFiles: ChangedFile[];
  requireDiagrams?: boolean;
  sequenceDiagram?: string | null;
  effectiveThinkingLevel: ThinkingLevel;
  effectiveTemperature?: number;
  onBilling?: (usage: Usage) => void;
  log: (...args: unknown[]) => void;
}): Promise<PrExplainerContent | null> {
  const agent = new Agent({
    initialState: {
      systemPrompt: buildPrExplainerSystemPrompt(Boolean(params.requireDiagrams)),
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
        eligibleFiles: params.eligibleFiles,
        requireDiagrams: Boolean(params.requireDiagrams),
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

function buildPrExplainerSystemPrompt(requireDiagrams: boolean): string {
  const diagramsSection = requireDiagrams
    ? `
- The "reviewGuide" MUST include two Mermaid diagrams in fenced blocks:
  1) A component relationship diagram (use flowchart/graph/class/C4 style).
  2) A sequence diagram (must start with "sequenceDiagram").
- Add headings exactly:
  - "## Component relationship diagram"
  - "## Sequence diagram"
- Validate both diagrams with the validate_mermaid tool before final output.
`
    : "";
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
- Only include fileComments for files from the "Eligible files for per-file comments" list.
- Skip fileComments for trivial low-risk edits (small formatting/docs/meta churn) even when eligible.
- Do not invent file paths.
- Consider the PR description when explaining intent and rationale.
- Each file comment must include these headings:
  - "What this file does"
  - "What changed"
  - "Why this changed"
- For high-risk files, also include a final section: "Review checklist (high-risk focus)".
- For low-risk files, do not add any extra final section beyond the three required headings above.
- If a high-risk checklist section is present, use plain markdown bullet points that start with "- ".
- Do not use task-list checkboxes (\`- [ ]\` or \`- [x]\`) in explainer comments.
- Never include "Low risk" content inside a "Review checklist (high-risk focus)" section.
- For lower-risk files, keep the "Why this changed" section concise and explicitly mention why risk is low.
- Keep content practical and brief; avoid repeating the same sentences across files.${diagramsSection}`;
}

function buildPrExplainerUserPrompt(params: {
  prInfo: PullRequestInfo;
  changedFiles: ChangedFile[];
  eligibleFiles: ChangedFile[];
  requireDiagrams: boolean;
  sequenceDiagram?: string | null;
}): string {
  const fileList = params.changedFiles
    .map((file) => `- ${file.filename} (status=${file.status}, +${file.additions}/-${file.deletions})`)
    .join("\n");
  const eligibleFileList = params.eligibleFiles.length > 0
    ? params.eligibleFiles
      .map((file) => `- ${file.filename} (status=${file.status}, +${file.additions}/-${file.deletions})`)
      .join("\n")
    : "(none)";
  const sequenceSection = params.sequenceDiagram?.trim()
    ? `\n\n# Prebuilt Sequence Diagram\n${params.sequenceDiagram.trim()}\n`
    : "";
  const diagramRequirementSection = params.requireDiagrams
    ? `\n# Required Review Guide Diagrams
This PR is large. "reviewGuide" must include:
- A component relationship Mermaid diagram under heading "## Component relationship diagram".
- A Mermaid sequence diagram under heading "## Sequence diagram".\n`
    : "";
  const body = params.prInfo.body?.trim() ? params.prInfo.body.trim() : "(no description)";
  return `# PR Context
Title: ${params.prInfo.title}
Description: ${body}
URL: ${params.prInfo.url}

Changed files:
${fileList}

Eligible files for per-file comments:
${eligibleFileList}
${sequenceSection}${diagramRequirementSection}
# Task
Produce a review guide and zero-or-more per-file explainer comments using the required JSON format.`;
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
  eligibleFiles: ChangedFile[]
): {
  reviewGuide: string;
  fileCommentByPath: Map<string, string>;
  unresolvedPaths: string[];
} {
  const reviewGuide = generated.reviewGuide?.trim() ?? "";
  const normalizedPathToFile = new Map<string, string>();
  for (const file of eligibleFiles) {
    normalizedPathToFile.set(normalizePathForMatch(file.filename), file.filename);
  }
  const map = new Map<string, string>();
  const unresolvedPaths: string[] = [];

  for (const entry of generated.fileComments) {
    const resolvedPath = resolveEligiblePath(entry.path, normalizedPathToFile);
    if (!resolvedPath) {
      unresolvedPaths.push(entry.path);
      continue;
    }
    map.set(resolvedPath, normalizeExplainerFileBody(entry.body));
  }
  return { reviewGuide, fileCommentByPath: map, unresolvedPaths };
}

function normalizePathForMatch(path: string): string {
  return path.trim().replace(/^\.\/+/, "");
}

function resolveEligiblePath(path: string, eligiblePathMap: Map<string, string>): string | null {
  const normalizedRaw = normalizePathForMatch(path);
  const normalized = normalizedRaw.replace(/^[ab]\//, "");
  const direct = eligiblePathMap.get(normalized) ?? eligiblePathMap.get(normalizedRaw);
  if (direct) return direct;

  const lower = normalized.toLowerCase();
  const lowerMatches = [...eligiblePathMap.entries()].filter(([candidate]) => candidate.toLowerCase() === lower);
  if (lowerMatches.length === 1) return lowerMatches[0][1];

  if (!normalized.includes("/")) {
    const suffixMatches = [...eligiblePathMap.entries()].filter(([candidate]) => candidate.endsWith(`/${normalized}`));
    if (suffixMatches.length === 1) return suffixMatches[0][1];
  }
  return null;
}

async function selectEligibleFilesForExplainer(
  changedFiles: ChangedFile[],
  repoRoot: string
): Promise<{
  eligibleFiles: ChangedFile[];
  skippedFiles: Array<{ file: string; reason: string }>;
}> {
  const checks = await Promise.all(
    changedFiles.map(async (file) => {
      const reason = await getExplainerSkipReason(file, repoRoot);
      return { file, reason };
    })
  );
  const eligibleFiles: ChangedFile[] = [];
  const skippedFiles: Array<{ file: string; reason: string }> = [];
  for (const check of checks) {
    if (check.reason) {
      skippedFiles.push({ file: check.file.filename, reason: check.reason });
      continue;
    }
    eligibleFiles.push(check.file);
  }
  return { eligibleFiles, skippedFiles };
}

async function getExplainerSkipReason(file: ChangedFile, repoRoot: string): Promise<string | null> {
  const normalized = file.filename.toLowerCase();

  if (isNoiseArtifactPath(normalized)) {
    return "noise-artifact";
  }

  if (await isGeneratedPath(repoRoot, file.filename)) {
    return "generated";
  }

  return null;
}

function isNoiseArtifactPath(normalizedPath: string): boolean {
  const basename = normalizedPath.split("/").at(-1) ?? normalizedPath;
  if (basename === "bun.lock" || basename === "bun.lockb") return true;
  if (basename === "package-lock.json" || basename === "pnpm-lock.yaml" || basename === "yarn.lock") return true;
  if (basename.endsWith(".log")) return true;
  if (basename.endsWith(".min.js") || basename.endsWith(".min.css")) return true;
  if (basename.endsWith(".map")) return true;
  if (basename.endsWith(".snap")) return true;
  if (normalizedPath.includes("/coverage/")) return true;
  return false;
}

async function validateReviewGuideDiagrams(
  reviewGuide: string,
  requireDiagrams: boolean
): Promise<{ ok: boolean; errors: string[] }> {
  if (!requireDiagrams) return { ok: true, errors: [] };

  const mermaidBlocks = extractMermaidBlocks(reviewGuide);
  if (mermaidBlocks.length === 0) {
    return {
      ok: false,
      errors: [
        "Large PR explainer requires Mermaid diagrams in `reviewGuide`, but none were found.",
      ],
    };
  }

  const validations = await Promise.all(mermaidBlocks.map((diagram) => validateMermaidDiagram(diagram)));
  const validDiagrams = validations.filter((entry) => entry.valid);
  const hasValidSequenceDiagram = validDiagrams.some(
    (entry) => entry.diagramType === "sequenceDiagram" || entry.diagramType === "sequence"
  );
  const hasValidComponentDiagram = validDiagrams.some(
    (entry) => entry.diagramType && entry.diagramType !== "sequenceDiagram" && entry.diagramType !== "sequence"
  );
  const errors: string[] = [];

  if (!hasValidComponentDiagram) {
    errors.push("Large PR explainer requires a valid Mermaid component relationship diagram in `reviewGuide`.");
  }
  if (!hasValidSequenceDiagram) {
    errors.push("Large PR explainer requires a valid Mermaid sequence diagram in `reviewGuide`.");
  }

  if (errors.length > 0) {
    const firstParseError = validations
      .flatMap((entry) => entry.errors)
      .find((error) => error.trim().length > 0);
    if (firstParseError) {
      errors.push(`Mermaid validation error: ${firstParseError}`);
    }
    return { ok: false, errors };
  }

  return { ok: true, errors: [] };
}

function extractMermaidBlocks(markdown: string): string[] {
  if (!markdown.trim()) return [];
  const blocks: string[] = [];
  const regex = /```mermaid\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(markdown)) !== null) {
    const block = match[1]?.trim();
    if (block) blocks.push(block);
  }
  return blocks;
}

function normalizeExplainerFileBody(body: string): string {
  const lines = body
    .trim()
    .replace(/\r\n/g, "\n")
    .split("\n");
  if (lines.length === 0) return "";

  // Normalize task list syntax to plain bullets for deterministic rendering.
  for (let i = 0; i < lines.length; i += 1) {
    lines[i] = lines[i].replace(/^- \[[ xX]\]\s+/, "- ");
  }

  const checklistHeadingIndex = lines.findIndex((line) => /^#{2,6}\s*Review checklist \(high-risk focus\)\s*$/i.test(line.trim()));
  if (checklistHeadingIndex !== -1) {
    let nextHeadingIndex = lines.length;
    for (let i = checklistHeadingIndex + 1; i < lines.length; i += 1) {
      if (/^#{2,6}\s+/.test(lines[i].trim())) {
        nextHeadingIndex = i;
        break;
      }
    }
    const checklistContent = lines.slice(checklistHeadingIndex + 1, nextHeadingIndex).join("\n");
    if (/\blow[- ]risk\b/i.test(checklistContent)) {
      lines.splice(checklistHeadingIndex, nextHeadingIndex - checklistHeadingIndex);
    }
  }

  const normalized = lines.join("\n");
  return normalized
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function upsertExplainerFailureComment(
  params: {
    octokit: Octokit;
    owner: string;
    repo: string;
    pullNumber: number;
    existingComments: ExistingComment[];
  },
  reasons: string[]
): Promise<void> {
  const body = ensureBotMarker([
    "⚠️ Experimental PR explainer failed for this run.",
    "",
    "Reasons:",
    ...reasons.map((reason) => `- ${reason}`),
    "",
    "No synthetic explainer content was posted.",
    "",
    REVIEW_GUIDE_FAILURE_MARKER,
  ].join("\n"));
  const existing = findLatestComment(
    params.existingComments.filter(
      (comment) =>
        comment.type === "issue" &&
        comment.body.includes(REVIEW_GUIDE_FAILURE_MARKER) &&
        isBotComment(comment)
    )
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
      if (typeof existing.line === "number") {
        const migrated = await tryCreateFileLevelReviewComment(params, file, body);
        if (migrated) {
          try {
            await params.octokit.rest.pulls.deleteReviewComment({
              owner: params.owner,
              repo: params.repo,
              comment_id: existing.id,
            });
          } catch (error) {
            params.log(`pr explainer failed to delete legacy inline comment ${existing.id}`, error);
          }
          return;
        }
      }
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

  const createdFileLevel = await tryCreateFileLevelReviewComment(params, file, body);
  if (createdFileLevel) {
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

async function tryCreateFileLevelReviewComment(
  params: {
    octokit: Octokit;
    owner: string;
    repo: string;
    pullNumber: number;
    headSha: string;
    log: (...args: unknown[]) => void;
  },
  file: ChangedFile,
  body: string
): Promise<boolean> {
  try {
    await params.octokit.rest.pulls.createReviewComment({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pullNumber,
      commit_id: params.headSha,
      path: file.filename,
      body,
      subject_type: "file",
    });
    return true;
  } catch (error) {
    if (!isRecoverableFileLevelCommentError(error)) {
      throw error;
    }
    params.log(`pr explainer fallback from file-level comment for ${file.filename}`);
    return false;
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

function isRecoverableFileLevelCommentError(error: any): boolean {
  const status = error?.status ?? error?.response?.status;
  if (status !== 400 && status !== 404 && status !== 422) return false;

  const errors = error?.response?.data?.errors;
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      const field = String(entry?.field ?? "");
      if (field === "line" || field === "subject_type" || field === "position") {
        return true;
      }
    }
  }

  const message = String(error?.message ?? error?.response?.data?.message ?? "");
  return /line|required|subject_type|position|validation|unprocessable|diff/i.test(message);
}
