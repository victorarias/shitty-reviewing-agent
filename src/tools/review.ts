import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { getOctokit } from "@actions/github";
import { RateLimitError } from "./github.js";
import { createTerminateTool } from "./terminate.js";
import type { ChangedFile, CommentType, ExistingComment, ReviewThreadInfo } from "../types.js";
import {
  buildAdaptiveSummaryMarkdown,
  hasHighRiskFindings,
  maxSummaryMode,
  normalizeSummaryCategory,
  normalizeSummarySeverity,
  normalizeSummaryStatus,
  summaryModeRank,
  type KeyFileSummary,
  type SummaryObservation,
  type StructuredSummaryFinding,
  type SummaryMode,
  type SummaryPlacement,
} from "../summary.js";

type Octokit = ReturnType<typeof getOctokit>;

const BOT_COMMENT_MARKER = "<!-- sri:bot-comment -->";
const FINDING_REF_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,79}$/;
const RESOLVE_THREAD_MUTATION = `mutation ResolveReviewThread($threadId: ID!) {\n  resolveReviewThread(input: { threadId: $threadId }) {\n    thread {\n      id\n      isResolved\n    }\n  }\n}`;
const SUMMARY_ONLY_REASON_HINT_PATTERNS = [
  /cross[- ]file/i,
  /multiple files/i,
  /no line-specific diff/i,
  /non-commentable/i,
  /binary/i,
  /too large to diff/i,
  /outdated diff/i,
  /unchanged since last review/i,
  /still open from prior review/i,
  /architectural/i,
];
const SUMMARY_ONLY_META_REASON_PATTERNS = [
  /verification of specific logic/i,
  /requested by previous file-level review guide/i,
  /validation requested/i,
];
const META_FINDING_TITLE_PATTERN = /^(verify|validation|check|confirm|assess|review)\b/i;
const SUMMARY_ONLY_SCOPE_TEXT_PATTERN = /\bsummary[-_ ]only\s+scope\s*:/i;
const PRAISE_ONLY_PATTERN =
  /\b(looks good|good refactor|robust implementation|solid foundation|works as expected|correctly handles|well done)\b/i;
const ISSUE_SIGNAL_PATTERN =
  /\b(bug|error|fail|failing|missing|incorrect|bypass|leak|race|insecure|broken|regression|coupl|duplica|unused|slow|latency|risk|vulnerab|crash|panic|deadlock|impact)\b/i;
const EVIDENCE_FILE_LINE_PATTERN = /^([^\s:][^:]*?):(\d+)(?::\d+)?(?:\b|$)/;
interface SummaryPolicy {
  isFollowUp: boolean;
  modeCandidate: SummaryMode;
  changedFileCount: number;
  changedLineCount: number;
  riskHints: string[];
}

interface ReviewToolDeps {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  modelId: string;
  reviewSha: string;
  changedFiles: ChangedFile[];
  getBilling: () => { input: number; output: number; total: number; cost: number };
  existingComments: ExistingComment[];
  reviewThreads: ReviewThreadInfo[];
  onSummaryPosted?: () => void;
  onInlineComment?: () => void;
  onSuggestion?: () => void;
  summaryPosted?: () => boolean;
  commentType?: CommentType;
  summaryPolicy?: SummaryPolicy;
}

interface FindingLink {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  commentId: number;
  commentUrl?: string;
  kind: "comment" | "suggestion";
}

interface SummaryDraftSnapshot {
  findings: StructuredSummaryFinding[];
  observations: SummaryObservation[];
  keyFiles: KeyFileSummary[];
}

export function createReviewTools(deps: ReviewToolDeps): AgentTool<any>[] {
  const { existingByLocation, threadActivityById, threadLastActorById, threadLastCommentById } = buildLocationIndex(deps.existingComments);
  const { threadsByLocation, threadsById, threadsByRootCommentId } = buildThreadIndex(deps.reviewThreads);
  const patchByPath = new Map(deps.changedFiles.map((file) => [file.filename, file.patch]));
  const changedPathSet = new Set(deps.changedFiles.map((file) => file.filename));
  const commentById = new Map(deps.existingComments.map((comment) => [comment.id, comment]));
  const summaryFindings: StructuredSummaryFinding[] = [];
  const findingIndexByRef = new Map<string, number>();
  const findingLinksByRef = new Map<string, FindingLink[]>();
  const keyFilesByPath = new Map<string, KeyFileSummary>();
  const summaryObservations: SummaryObservation[] = [];
  const observationIndexByRef = new Map<string, number>();
  let summaryModeOverride: SummaryMode | null = null;
  let summaryModeReason = "";
  let summaryModeEvidence: string[] = [];

  const recordFindingLink = (
    findingRef: string | undefined,
    location: { path: string; line: number; side: "LEFT" | "RIGHT" | undefined },
    commentId: number,
    kind: "comment" | "suggestion",
    commentUrl?: string
  ) => {
    if (!findingRef) return;
    const side = location.side ?? "RIGHT";
    const links = findingLinksByRef.get(findingRef) ?? [];
    if (links.some((link) => link.path === location.path && link.line === location.line && link.side === side && link.commentId === commentId)) {
      return;
    }
    links.push({
      path: location.path,
      line: location.line,
      side,
      commentId,
      commentUrl,
      kind,
    });
    findingLinksByRef.set(findingRef, links);
  };
  const getFindingByRef = (findingRef: string | undefined): StructuredSummaryFinding | undefined => {
    if (!findingRef) return undefined;
    const index = findingIndexByRef.get(findingRef);
    if (index === undefined) return undefined;
    return summaryFindings[index];
  };
  const buildSummaryDraft = (): SummaryDraftSnapshot => {
    const findings = summaryFindings.map((finding) => ({
      ...finding,
      linkedLocations: finding.findingRef ? formatFindingLinks(findingLinksByRef.get(finding.findingRef)) : [],
    }));
    const keyFiles = resolveSummaryKeyFiles(deps.changedFiles, [...keyFilesByPath.values()]);
    return {
      findings,
      observations: [...summaryObservations],
      keyFiles,
    };
  };
  const listThreadsTool: AgentTool<typeof ListThreadsSchema, { threads: ReviewThreadInfo[] }> = {
    name: "list_threads_for_location",
    label: "List review threads for location",
    description: "List existing review threads for a file/line (optionally filtered by side).",
    parameters: ListThreadsSchema,
    execute: async (_id, params) => {
      const side = params.side as "LEFT" | "RIGHT" | undefined;
      const threads = findThreadsAtLocation(threadsByLocation, params.path, params.line, side);
      return {
        content: [{ type: "text", text: JSON.stringify(threads, null, 2) }],
        details: { threads },
      };
    },
  };

  const commentTool: AgentTool<typeof CommentSchema, { id: number }> = {
    name: "comment",
    label: "Post inline comment",
    description: "Post an inline comment on a specific line in a file.",
    parameters: CommentSchema,
    execute: async (_id, params) => {
      const side = params.side as "LEFT" | "RIGHT" | undefined;
      const findingRef = normalizeFindingRef(params.finding_ref);
      if (params.finding_ref && !findingRef) {
        return {
          content: [{ type: "text", text: `Invalid finding_ref "${params.finding_ref}". Use lowercase letters/numbers with . _ : - only.` }],
          details: { id: -1 },
        };
      }
      const finding = getFindingByRef(findingRef);
      if (findingRef && !finding) {
        return {
          content: [{
            type: "text",
            text: `Unknown finding_ref "${findingRef}". Call report_finding first so change context and traceability metadata can be attached.`,
          }],
          details: { id: -1 },
        };
      }
      const body = ensureBotMarker(ensureFindingRefMarker(ensureFindingContextLabel(params.body, finding), findingRef));
      if (params.thread_id) {
        const thread = threadsById.get(params.thread_id);
        if (!thread?.rootCommentId) {
          return {
            content: [{ type: "text", text: `Thread ${params.thread_id} not found or missing root comment.` }],
            details: { id: -1 },
          };
        }
        const latest = getLatestThreadComment(thread.rootCommentId, threadLastCommentById, thread.lastActor);
        if (latest && shouldUpdateDuplicateBot(latest.author, thread, latest.authorType)) {
          return buildDuplicateUpdateResponse(params.path, params.line, latest.id, latest.author, thread.id);
        }
        const response = await safeCall(() =>
          deps.octokit.rest.pulls.createReplyForReviewComment({
            owner: deps.owner,
            repo: deps.repo,
            pull_number: deps.pullNumber,
            comment_id: thread.rootCommentId,
            body,
          })
        );
        deps.onInlineComment?.();
        recordFindingLink(findingRef, { path: params.path, line: params.line, side }, response.data.id, "comment", response.data.html_url);
        return {
          content: [{ type: "text", text: `Reply posted: ${response.data.id}` }],
          details: { id: response.data.id },
        };
      }
      const diffCheck = lineExistsInDiff(patchByPath.get(params.path), params.line, side);
      if (!diffCheck.ok) {
        return {
          content: [{ type: "text", text: diffCheck.message }],
          details: { id: -1 },
        };
      }

      const threadsAtLocation = findThreadsAtLocation(threadsByLocation, params.path, params.line);
      if (threadsAtLocation.length > 0 && !params.allow_new_thread) {
        if (!side) {
          return buildThreadAmbiguityResponse(params.path, params.line, threadsAtLocation);
        }
        const sideThreads = threadsAtLocation.filter((thread) => thread.side === side);
        if (sideThreads.length > 1) {
          return buildThreadAmbiguityResponse(params.path, params.line, sideThreads, side);
        }
        if (sideThreads.length === 1) {
          const thread = sideThreads[0];
          if (thread.rootCommentId) {
            const latest = getLatestThreadComment(thread.rootCommentId, threadLastCommentById, thread.lastActor);
            if (latest && shouldUpdateDuplicateBot(latest.author, thread, latest.authorType)) {
              return buildDuplicateUpdateResponse(params.path, params.line, latest.id, latest.author, thread.id);
            }
            const response = await safeCall(() =>
              deps.octokit.rest.pulls.createReplyForReviewComment({
                owner: deps.owner,
                repo: deps.repo,
                pull_number: deps.pullNumber,
                comment_id: thread.rootCommentId,
                body,
              })
            );
            deps.onInlineComment?.();
            recordFindingLink(findingRef, { path: params.path, line: params.line, side }, response.data.id, "comment", response.data.html_url);
            return {
              content: [{ type: "text", text: `Reply posted: ${response.data.id}` }],
              details: { id: response.data.id },
            };
          }
          return {
            content: [{ type: "text", text: `Thread ${thread.id} missing root comment; choose another thread or open a new one.` }],
            details: { id: -1 },
          };
        }
      }

      const existing = findLatestLocation(existingByLocation, threadActivityById, params.path, params.line, side);
      if (existing && !params.allow_new_thread) {
        const thread = threadsByRootCommentId.get(existing.id);
        const latest = getLatestThreadComment(
          existing.id,
          threadLastCommentById,
          threadLastActorById.get(existing.id) ?? existing.author,
          existing.authorType
        );
        if (latest && shouldUpdateDuplicateBot(latest.author, thread, latest.authorType)) {
          return buildDuplicateUpdateResponse(params.path, params.line, latest.id, latest.author, thread?.id);
        }
        const response = await safeCall(() =>
          deps.octokit.rest.pulls.createReplyForReviewComment({
            owner: deps.owner,
            repo: deps.repo,
            pull_number: deps.pullNumber,
            comment_id: existing.id,
            body,
          })
        );
        deps.onInlineComment?.();
        recordFindingLink(findingRef, { path: params.path, line: params.line, side }, response.data.id, "comment", response.data.html_url);
        return {
          content: [{ type: "text", text: `Reply posted: ${response.data.id}` }],
          details: { id: response.data.id },
        };
      }
      const response = await safeCall(() =>
        deps.octokit.rest.pulls.createReviewComment({
          owner: deps.owner,
          repo: deps.repo,
          pull_number: deps.pullNumber,
          commit_id: deps.headSha,
          path: params.path,
          line: params.line,
          side: side ?? "RIGHT",
          body,
        })
      );
      deps.onInlineComment?.();
      recordFindingLink(findingRef, { path: params.path, line: params.line, side }, response.data.id, "comment", response.data.html_url);
      return {
        content: [{ type: "text", text: `Comment posted: ${response.data.id}` }],
        details: { id: response.data.id },
      };
    },
  };

  const suggestTool: AgentTool<typeof SuggestSchema, { id: number }> = {
    name: "suggest",
    label: "Post suggestion block",
    description: "Post a GitHub suggestion block (single-hunk fix).",
    parameters: SuggestSchema,
    execute: async (_id, params) => {
      const side = params.side as "LEFT" | "RIGHT" | undefined;
      const findingRef = normalizeFindingRef(params.finding_ref);
      if (params.finding_ref && !findingRef) {
        return {
          content: [{ type: "text", text: `Invalid finding_ref "${params.finding_ref}". Use lowercase letters/numbers with . _ : - only.` }],
          details: { id: -1 },
        };
      }
      const finding = getFindingByRef(findingRef);
      if (findingRef && !finding) {
        return {
          content: [{
            type: "text",
            text: `Unknown finding_ref "${findingRef}". Call report_finding first so change context and traceability metadata can be attached.`,
          }],
          details: { id: -1 },
        };
      }
      const suggestionBody = wrapSuggestion(params.suggestion, params.comment);
      const body = ensureBotMarker(ensureFindingRefMarker(ensureFindingContextLabel(suggestionBody, finding), findingRef));
      if (params.thread_id) {
        const thread = threadsById.get(params.thread_id);
        if (!thread?.rootCommentId) {
          return {
            content: [{ type: "text", text: `Thread ${params.thread_id} not found or missing root comment.` }],
            details: { id: -1 },
          };
        }
        const latest = getLatestThreadComment(thread.rootCommentId, threadLastCommentById, thread.lastActor);
        if (latest && shouldUpdateDuplicateBot(latest.author, thread, latest.authorType)) {
          return buildDuplicateUpdateResponse(params.path, params.line, latest.id, latest.author, thread.id);
        }
        const response = await safeCall(() =>
          deps.octokit.rest.pulls.createReplyForReviewComment({
            owner: deps.owner,
            repo: deps.repo,
            pull_number: deps.pullNumber,
            comment_id: thread.rootCommentId,
            body,
          })
        );
        deps.onSuggestion?.();
        recordFindingLink(findingRef, { path: params.path, line: params.line, side }, response.data.id, "suggestion", response.data.html_url);
        return {
          content: [{ type: "text", text: `Suggestion reply posted: ${response.data.id}` }],
          details: { id: response.data.id },
        };
      }
      const diffCheck = lineExistsInDiff(patchByPath.get(params.path), params.line, side);
      if (!diffCheck.ok) {
        return {
          content: [{ type: "text", text: diffCheck.message }],
          details: { id: -1 },
        };
      }

      const threadsAtLocation = findThreadsAtLocation(threadsByLocation, params.path, params.line);
      if (threadsAtLocation.length > 0 && !params.allow_new_thread) {
        if (!side) {
          return buildThreadAmbiguityResponse(params.path, params.line, threadsAtLocation);
        }
        const sideThreads = threadsAtLocation.filter((thread) => thread.side === side);
        if (sideThreads.length > 1) {
          return buildThreadAmbiguityResponse(params.path, params.line, sideThreads, side);
        }
        if (sideThreads.length === 1) {
          const thread = sideThreads[0];
          if (thread.rootCommentId) {
            const latest = getLatestThreadComment(thread.rootCommentId, threadLastCommentById, thread.lastActor);
            if (latest && shouldUpdateDuplicateBot(latest.author, thread, latest.authorType)) {
              return buildDuplicateUpdateResponse(params.path, params.line, latest.id, latest.author, thread.id);
            }
            const response = await safeCall(() =>
              deps.octokit.rest.pulls.createReplyForReviewComment({
                owner: deps.owner,
                repo: deps.repo,
                pull_number: deps.pullNumber,
                comment_id: thread.rootCommentId,
                body,
              })
            );
            deps.onSuggestion?.();
            recordFindingLink(findingRef, { path: params.path, line: params.line, side }, response.data.id, "suggestion", response.data.html_url);
            return {
              content: [{ type: "text", text: `Suggestion reply posted: ${response.data.id}` }],
              details: { id: response.data.id },
            };
          }
          return {
            content: [{ type: "text", text: `Thread ${thread.id} missing root comment; choose another thread or open a new one.` }],
            details: { id: -1 },
          };
        }
      }

      const existing = findLatestLocation(existingByLocation, threadActivityById, params.path, params.line, side);
      if (existing && !params.allow_new_thread) {
        const thread = threadsByRootCommentId.get(existing.id);
        const latest = getLatestThreadComment(
          existing.id,
          threadLastCommentById,
          threadLastActorById.get(existing.id) ?? existing.author,
          existing.authorType
        );
        if (latest && shouldUpdateDuplicateBot(latest.author, thread, latest.authorType)) {
          return buildDuplicateUpdateResponse(params.path, params.line, latest.id, latest.author, thread?.id);
        }
        const response = await safeCall(() =>
          deps.octokit.rest.pulls.createReplyForReviewComment({
            owner: deps.owner,
            repo: deps.repo,
            pull_number: deps.pullNumber,
            comment_id: existing.id,
            body,
          })
        );
        deps.onSuggestion?.();
        recordFindingLink(findingRef, { path: params.path, line: params.line, side }, response.data.id, "suggestion", response.data.html_url);
        return {
          content: [{ type: "text", text: `Suggestion reply posted: ${response.data.id}` }],
          details: { id: response.data.id },
        };
      }
      const response = await safeCall(() =>
        deps.octokit.rest.pulls.createReviewComment({
          owner: deps.owner,
          repo: deps.repo,
          pull_number: deps.pullNumber,
          commit_id: deps.headSha,
          path: params.path,
          line: params.line,
          side: side ?? "RIGHT",
          body,
        })
      );
      deps.onSuggestion?.();
      recordFindingLink(findingRef, { path: params.path, line: params.line, side }, response.data.id, "suggestion", response.data.html_url);
      return {
        content: [{ type: "text", text: `Suggestion posted: ${response.data.id}` }],
        details: { id: response.data.id },
      };
    },
  };

  const updateTool: AgentTool<typeof UpdateSchema, { id: number }> = {
    name: "update_comment",
    label: "Update PR comment",
    description: "Update an existing PR comment (review or issue comment).",
    parameters: UpdateSchema,
    execute: async (_id, params) => {
      const mode = deps.commentType ?? "both";
      const existing = commentById.get(params.comment_id);
      const body = ensureBotMarker(params.body);
      const updateByType = async (type: "review" | "issue") => {
        if (type === "review") {
          return safeCall(() =>
            deps.octokit.rest.pulls.updateReviewComment({
              owner: deps.owner,
              repo: deps.repo,
              comment_id: params.comment_id,
              body,
            })
          );
        }
        return safeCall(() =>
          deps.octokit.rest.issues.updateComment({
            owner: deps.owner,
            repo: deps.repo,
            comment_id: params.comment_id,
            body,
          })
        );
      };

      if (existing && mode !== "both" && existing.type !== mode) {
        return {
          content: [
            {
              type: "text",
              text: `Comment ${params.comment_id} is a ${existing.type} comment and cannot be updated in ${mode}-only mode.`,
            },
          ],
          details: { id: -1 },
        };
      }

      const candidateTypes: ("review" | "issue")[] = [];
      if (existing?.type) {
        candidateTypes.push(existing.type);
      } else if (mode === "review" || mode === "issue") {
        candidateTypes.push(mode);
      } else {
        candidateTypes.push("review", "issue");
      }

      for (let i = 0; i < candidateTypes.length; i += 1) {
        const type = candidateTypes[i];
        try {
          const response = await updateByType(type);
          return {
            content: [{ type: "text", text: `Comment updated: ${response.data.id}` }],
            details: { id: response.data.id },
          };
        } catch (error: any) {
          const canFallback = i < candidateTypes.length - 1;
          if (!canFallback || !isLikelyWrongCommentType(error)) {
            throw error;
          }
        }
      }

      return {
        content: [{ type: "text", text: `Comment ${params.comment_id} could not be updated.` }],
        details: { id: -1 },
      };
    },
  };

  const replyTool: AgentTool<typeof ReplySchema, { id: number }> = {
    name: "reply_comment",
    label: "Reply to review comment",
    description: "Reply to an existing review comment thread.",
    parameters: ReplySchema,
    execute: async (_id, params) => {
      const response = await safeCall(() =>
        deps.octokit.rest.pulls.createReplyForReviewComment({
          owner: deps.owner,
          repo: deps.repo,
          pull_number: deps.pullNumber,
          comment_id: params.comment_id,
          body: ensureBotMarker(params.body),
        })
      );
      return {
        content: [{ type: "text", text: `Reply posted: ${response.data.id}` }],
        details: { id: response.data.id },
      };
    },
  };

  const resolveTool: AgentTool<typeof ResolveSchema, { id: number }> = {
    name: "resolve_thread",
    label: "Resolve review thread",
    description: "Reply with an explanation and resolve a review thread created by this bot.",
    parameters: ResolveSchema,
    execute: async (_id, params) => {
      const explanation = params.body?.trim();
      if (!explanation || explanation === BOT_COMMENT_MARKER) {
        return {
          content: [{ type: "text", text: "Resolution requires a non-empty explanation in body." }],
          details: { id: -1 },
        };
      }
      const thread = threadsById.get(params.thread_id) ?? threadsByRootCommentId.get(params.thread_id);
      if (!thread) {
        return {
          content: [{ type: "text", text: `Thread ${params.thread_id} not found.` }],
          details: { id: -1 },
        };
      }
      if (thread.resolved) {
        return {
          content: [{ type: "text", text: `Thread ${thread.id} is already resolved.` }],
          details: { id: -1 },
        };
      }
      const rootId = thread.rootCommentId ?? thread.id;
      const rootComment = commentById.get(rootId);
      if (!rootComment) {
        return {
          content: [{ type: "text", text: `Unable to load root comment for thread ${thread.id}.` }],
          details: { id: -1 },
        };
      }
      if (!isBotComment(rootComment)) {
        return {
          content: [{ type: "text", text: `Thread ${thread.id} is not authored by this bot; refusing to resolve.` }],
          details: { id: -1 },
        };
      }
      if (!thread.threadId) {
        return {
          content: [{ type: "text", text: `Thread ${thread.id} missing GraphQL thread id; cannot resolve.` }],
          details: { id: -1 },
        };
      }
      const reply = await safeCall(() =>
        deps.octokit.rest.pulls.createReplyForReviewComment({
          owner: deps.owner,
          repo: deps.repo,
          pull_number: deps.pullNumber,
          comment_id: rootId,
          body: ensureBotMarker(params.body),
        })
      );
      try {
        await safeCall(() =>
          deps.octokit.graphql(RESOLVE_THREAD_MUTATION, {
            threadId: thread.threadId,
          })
        );
        return {
          content: [{ type: "text", text: `Resolved thread ${thread.id} with reply ${reply.data.id}.` }],
          details: { id: reply.data.id },
        };
      } catch (error) {
        if (isIntegrationAccessError(error)) {
          return {
            content: [{
              type: "text",
              text: `Reply posted: ${reply.data.id}. Unable to resolve thread ${thread.id} due to integration permissions; mention in summary and move on.`,
            }],
            details: { id: reply.data.id },
          };
        }
        throw error;
      }
    },
  };

  const reportFindingTool: AgentTool<typeof ReportFindingSchema, { count: number }> = {
    name: "report_finding",
    label: "Report finding",
    description: "Record a structured finding for deterministic summary rendering.",
    parameters: ReportFindingSchema,
    execute: async (_id, params) => {
      const findingRef = normalizeFindingRef(params.finding_ref);
      const category = normalizeSummaryCategory(params.category);
      const severity = normalizeSummarySeverity(params.severity);
      const status = normalizeSummaryStatus(params.status ?? "new");
      const title = params.title?.trim();
      if (!findingRef || !category || !severity || !status || !title) {
        return {
          content: [{
            type: "text",
            text:
              "Invalid finding payload. Provide finding_ref, category, severity, status, and title.",
          }],
          details: { count: summaryFindings.length },
        };
      }
      const placement = normalizeFindingPlacement(params.placement, status);
      const summaryOnlyReason = params.summary_only_reason?.trim() || undefined;
      if (placement === "summary_only" && !summaryOnlyReason) {
        return {
          content: [{
            type: "text",
            text: `Finding ${findingRef} uses placement=summary_only and requires summary_only_reason.`,
          }],
          details: { count: summaryFindings.length },
        };
      }
      const details = params.details?.trim() || undefined;
      const action = params.action?.trim() || undefined;
      const narrativeValidation = validateFindingNarrative({
        title,
        details,
        action,
      });
      if (narrativeValidation.ok === false) {
        return {
          content: [{
            type: "text",
            text: `Finding ${findingRef} rejected: ${narrativeValidation.message} Use report_observation for non-issue context.`,
          }],
          details: { count: summaryFindings.length },
        };
      }
      const finding: StructuredSummaryFinding = {
        findingRef,
        category,
        severity,
        status,
        placement,
        summaryOnlyReason,
        title,
        details,
        evidence: (params.evidence ?? []).map((item) => item.trim()).filter(Boolean),
        action,
      };
      const existingIndex = findingIndexByRef.get(findingRef);
      if (existingIndex !== undefined) {
        summaryFindings[existingIndex] = finding;
      } else {
        summaryFindings.push(finding);
        findingIndexByRef.set(findingRef, summaryFindings.length - 1);
      }
      return {
        content: [{
          type: "text",
          text: existingIndex !== undefined
            ? `Finding updated (${findingRef}).`
            : `Finding recorded (${summaryFindings.length}).`,
        }],
        details: { count: summaryFindings.length },
      };
    },
  };

  const reportKeyFileTool: AgentTool<typeof ReportKeyFileSchema, { count: number }> = {
    name: "report_key_file",
    label: "Report key file",
    description: "Record key-file context for summary rendering.",
    parameters: ReportKeyFileSchema,
    execute: async (_id, params) => {
      const path = params.path.trim();
      if (!path) {
        return {
          content: [{ type: "text", text: "report_key_file requires a non-empty path." }],
          details: { count: keyFilesByPath.size },
        };
      }
      if (!changedPathSet.has(path)) {
        return {
          content: [{ type: "text", text: `Path ${path} is not in changed files. Only report changed files as key files.` }],
          details: { count: keyFilesByPath.size },
        };
      }
      const fallback = buildAutoKeyFileSummary(deps.changedFiles, path);
      keyFilesByPath.set(path, {
        path,
        whyReview: params.why_review?.trim() || "n/a",
        whatFileDoes: params.what_file_does?.trim() || "n/a",
        whatChanged: params.what_changed?.trim() || fallback,
        whyChanged: params.why_changed?.trim() || "n/a",
        reviewChecklist: (params.review_checklist ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 5),
        impactMap: params.impact_map?.trim() || undefined,
      });
      return {
        content: [{ type: "text", text: `Key file recorded (${keyFilesByPath.size}).` }],
        details: { count: keyFilesByPath.size },
      };
    },
  };

  const reportObservationTool: AgentTool<typeof ReportObservationSchema, { count: number }> = {
    name: "report_observation",
    label: "Report observation",
    description: "Record non-issue context that should appear in summary key findings.",
    parameters: ReportObservationSchema,
    execute: async (_id, params) => {
      const title = params.title.trim();
      if (!title) {
        return {
          content: [{ type: "text", text: "report_observation requires title." }],
          details: { count: summaryObservations.length },
        };
      }
      const category = normalizeObservationCategory(params.category);
      const observation: SummaryObservation = {
        category,
        title,
        details: params.details?.trim() || undefined,
      };
      const observationRef = normalizeFindingRef(params.observation_ref);
      if (params.observation_ref && !observationRef) {
        return {
          content: [{ type: "text", text: `Invalid observation_ref "${params.observation_ref}".` }],
          details: { count: summaryObservations.length },
        };
      }
      if (observationRef) {
        const existingIndex = observationIndexByRef.get(observationRef);
        if (existingIndex !== undefined) {
          summaryObservations[existingIndex] = observation;
          return {
            content: [{ type: "text", text: `Observation updated (${observationRef}).` }],
            details: { count: summaryObservations.length },
          };
        }
        summaryObservations.push(observation);
        observationIndexByRef.set(observationRef, summaryObservations.length - 1);
      } else {
        summaryObservations.push(observation);
      }
      return {
        content: [{ type: "text", text: `Observation recorded (${summaryObservations.length}).` }],
        details: { count: summaryObservations.length },
      };
    },
  };

  const setSummaryModeTool: AgentTool<typeof SetSummaryModeSchema, { mode: SummaryMode }> = {
    name: "set_summary_mode",
    label: "Set summary mode",
    description: "Escalate summary verbosity mode when risk is higher than deterministic scope suggests.",
    parameters: SetSummaryModeSchema,
    execute: async (_id, params) => {
      const requestedMode = params.mode as SummaryMode;
      const baseMode = deps.summaryPolicy?.modeCandidate ?? "standard";
      const currentMode = summaryModeOverride ?? baseMode;

      if (summaryModeRank(requestedMode) < summaryModeRank(baseMode)) {
        return {
          content: [{ type: "text", text: `Refusing to downgrade below deterministic mode ${baseMode}.` }],
          details: { mode: currentMode },
        };
      }

      if (summaryModeRank(requestedMode) < summaryModeRank(currentMode)) {
        return {
          content: [{ type: "text", text: `Ignoring downgrade request. Current mode is ${currentMode}.` }],
          details: { mode: currentMode },
        };
      }

      const evidence = (params.evidence ?? []).map((item) => item.trim()).filter(Boolean);
      if (requestedMode === "alert" && evidence.length === 0) {
        return {
          content: [{ type: "text", text: "Alert mode requires evidence entries (file/line or thread references)." }],
          details: { mode: currentMode },
        };
      }

      summaryModeOverride = requestedMode;
      summaryModeReason = params.reason.trim();
      summaryModeEvidence = evidence;
      return {
        content: [{ type: "text", text: `Summary mode set to ${requestedMode}.` }],
        details: { mode: requestedMode },
      };
    },
  };

  const summaryTool: AgentTool<typeof SummarySchema, { id: number }> = {
    name: "post_summary",
    label: "Post summary",
    description: "Post the final review summary as a PR comment using structured findings.",
    parameters: SummarySchema,
    execute: async (_id, params) => {
      const legacyBody = (params as Record<string, unknown>).body;
      if (typeof legacyBody === "string" && legacyBody.trim()) {
        return {
          content: [{
            type: "text",
            text: "post_summary.body is no longer supported. Use report_finding + post_summary({ verdict, preface }).",
          }],
          details: { id: -1 },
        };
      }
      if (deps.summaryPosted?.()) {
        return {
          content: [{ type: "text", text: "Summary already posted. Skipping duplicate." }],
          details: { id: -1 },
        };
      }
      const draft = buildSummaryDraft();
      const summaryValidation = validateSummaryFindings(draft.findings, findingLinksByRef);
      if (summaryValidation.ok === false) {
        return {
          content: [{ type: "text", text: summaryValidation.message }],
          details: { id: -1 },
        };
      }
      const verdict = normalizeVerdict(params.verdict) ?? inferVerdict(draft.findings);
      const verdictValidation = validateSummaryVerdict(verdict, draft.findings);
      if (verdictValidation.ok === false) {
        return {
          content: [{ type: "text", text: verdictValidation.message }],
          details: { id: -1 },
        };
      }
      const baseMode = deps.summaryPolicy?.modeCandidate ?? "standard";
      const derivedMode = summaryModeOverride ?? baseMode;
      const hintedRisk = Boolean(deps.summaryPolicy?.riskHints && deps.summaryPolicy.riskHints.length > 0);
      const hasUnresolvedMediumOrHigh = draft.findings.some(
        (finding) => finding.status !== "resolved" && finding.severity !== "low"
      );
      const riskAwareMode = hintedRisk && hasUnresolvedMediumOrHigh ? maxSummaryMode(derivedMode, "standard") : derivedMode;
      const effectiveMode = hasHighRiskFindings(draft.findings) ? maxSummaryMode(riskAwareMode, "alert") : riskAwareMode;
      // Mark as posted immediately to prevent racing duplicate calls.
      deps.onSummaryPosted?.();
      const summaryBody = buildAdaptiveSummaryMarkdown({
        verdict,
        preface: params.preface,
        findings: draft.findings,
        keyFiles: draft.keyFiles,
        observations: draft.observations,
        mode: effectiveMode,
        isFollowUp: deps.summaryPolicy?.isFollowUp ?? false,
        modeReason: summaryModeReason,
        modeEvidence: summaryModeEvidence,
      });
      const body = ensureSummaryFooter(summaryBody, deps.modelId, deps.getBilling(), deps.reviewSha);
      const response = await safeCall(() =>
        deps.octokit.rest.issues.createComment({
          owner: deps.owner,
          repo: deps.repo,
          issue_number: deps.pullNumber,
          body,
        })
      );
      return {
        content: [{ type: "text", text: `Summary posted: ${response.data.id}` }],
        details: { id: response.data.id },
      };
    },
  };

  return [
    listThreadsTool,
    commentTool,
    suggestTool,
    updateTool,
    replyTool,
    resolveTool,
    reportFindingTool,
    reportKeyFileTool,
    reportObservationTool,
    setSummaryModeTool,
    summaryTool,
    createTerminateTool(),
  ];
}

const CommentSchema = Type.Object({
  path: Type.String({ description: "File path" }),
  line: Type.Integer({ minimum: 1 }),
  side: Type.Optional(Type.String({ description: "LEFT or RIGHT", enum: ["LEFT", "RIGHT"] })),
  thread_id: Type.Optional(Type.Integer({ minimum: 1, description: "Existing thread id to reply to." })),
  allow_new_thread: Type.Optional(Type.Boolean({ description: "Set true to force a new thread even if one exists." })),
  finding_ref: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 80,
    pattern: "^[a-z0-9][a-z0-9._:-]{0,79}$",
    description: "Optional finding reference that links this inline comment to report_finding.",
  })),
  body: Type.String({ description: "Markdown body" }),
});

const SuggestSchema = Type.Object({
  path: Type.String({ description: "File path" }),
  line: Type.Integer({ minimum: 1 }),
  side: Type.Optional(Type.String({ description: "LEFT or RIGHT", enum: ["LEFT", "RIGHT"] })),
  thread_id: Type.Optional(Type.Integer({ minimum: 1, description: "Existing thread id to reply to." })),
  allow_new_thread: Type.Optional(Type.Boolean({ description: "Set true to force a new thread even if one exists." })),
  finding_ref: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 80,
    pattern: "^[a-z0-9][a-z0-9._:-]{0,79}$",
    description: "Optional finding reference that links this suggestion to report_finding.",
  })),
  comment: Type.Optional(Type.String({ description: "Optional comment before suggestion" })),
  suggestion: Type.String({ description: "Replacement code for suggestion block" }),
});

const ListThreadsSchema = Type.Object({
  path: Type.String({ description: "File path" }),
  line: Type.Integer({ minimum: 1 }),
  side: Type.Optional(Type.String({ description: "LEFT or RIGHT", enum: ["LEFT", "RIGHT"] })),
});

const ReportFindingSchema = Type.Object({
  finding_ref: Type.String({
    minLength: 1,
    maxLength: 80,
    pattern: "^[a-z0-9][a-z0-9._:-]{0,79}$",
    description: "Stable reference id linking this finding to inline comments/suggestions.",
  }),
  category: Type.String({
    description: "Finding category",
    enum: ["bug", "security", "performance", "unused_code", "duplicated_code", "refactoring", "design", "documentation"],
  }),
  severity: Type.String({ description: "Finding severity", enum: ["low", "medium", "high"] }),
  status: Type.Optional(Type.String({ description: "Finding lifecycle status", enum: ["new", "resolved", "still_open"] })),
  placement: Type.Optional(Type.String({
    description: "inline for file-thread findings, summary_only for cross-file/non-line-specific findings.",
    enum: ["inline", "summary_only"],
  })),
  summary_only_reason: Type.Optional(Type.String({ description: "Required when placement is summary_only." })),
  title: Type.String({ description: "Short issue title." }),
  details: Type.Optional(Type.String({ description: "Optional one-line detail for context." })),
  evidence: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  action: Type.Optional(Type.String({ description: "Optional requested reviewer action." })),
});

const ReportKeyFileSchema = Type.Object({
  path: Type.String({ minLength: 1, description: "Changed file path." }),
  why_review: Type.Optional(Type.String({ description: "Why this file deserves reviewer attention." })),
  what_file_does: Type.Optional(Type.String({ description: "Short explanation of this file's role." })),
  what_changed: Type.Optional(Type.String({ description: "What changed in this file." })),
  why_changed: Type.Optional(Type.String({ description: "Why this file changed." })),
  review_checklist: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  impact_map: Type.Optional(Type.String({ description: "Optional dependency/flow mapping." })),
});

const ReportObservationSchema = Type.Object({
  observation_ref: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 80,
    pattern: "^[a-z0-9][a-z0-9._:-]{0,79}$",
    description: "Optional stable reference id for upserting an observation.",
  })),
  category: Type.String({
    enum: ["context", "testing", "risk", "architecture"],
    description: "Observation category shown in Key Findings.",
  }),
  title: Type.String({ minLength: 1, description: "Observation title." }),
  details: Type.Optional(Type.String({ description: "Optional observation details." })),
});

const SetSummaryModeSchema = Type.Object({
  mode: Type.String({ enum: ["compact", "standard", "alert"] }),
  reason: Type.String({ minLength: 1 }),
  evidence: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});

const SummarySchema = Type.Object({
  verdict: Type.Optional(Type.String({ enum: ["Request Changes", "Approve", "Skipped"] })),
  preface: Type.Optional(Type.String({ description: "Optional one-sentence summary preface." })),
}, {
  additionalProperties: false,
  minProperties: 1,
});

const ReplySchema = Type.Object({
  comment_id: Type.Integer({ minimum: 1 }),
  body: Type.String({ description: "Reply body" }),
});

const ResolveSchema = Type.Object({
  thread_id: Type.Integer({ minimum: 1, description: "Thread id to resolve." }),
  body: Type.String({ description: "Explanation for why the thread is resolved." }),
});

const UpdateSchema = Type.Object({
  comment_id: Type.Integer({ minimum: 1 }),
  body: Type.String({ description: "Updated comment body" }),
});

function wrapSuggestion(suggestion: string, comment?: string): string {
  const prefix = comment?.trim() ? `${comment.trim()}\n\n` : "";
  return `${prefix}\`\`\`suggestion\n${suggestion}\n\`\`\``;
}

function ensureBotMarker(body: string): string {
  if (body.includes(BOT_COMMENT_MARKER)) return body;
  const trimmed = body.trim();
  if (!trimmed) return BOT_COMMENT_MARKER;
  return `${body}\n\n${BOT_COMMENT_MARKER}`;
}

function ensureFindingRefMarker(body: string, findingRef: string | undefined): string {
  if (!findingRef) return body;
  const marker = `<!-- sri:finding-ref:${findingRef} -->`;
  if (body.includes(marker)) return body;
  return `${body}\n${marker}`;
}

function ensureFindingContextLabel(body: string, finding: StructuredSummaryFinding | undefined): string {
  if (!finding) return body;
  const slug = finding.category.toLowerCase().replace(/\s+/g, "_");
  const marker = `<!-- sri:finding-category:${slug} -->`;
  if (body.includes(marker)) return body;
  const trimmed = body.trim();
  const contextLine = deriveFindingChangeContext(finding);
  if (!trimmed) {
    return `${contextLine}\n${marker}`;
  }
  return `${contextLine}\n\n${trimmed}\n${marker}`;
}

function deriveFindingChangeContext(finding: StructuredSummaryFinding): string {
  const detailsLine = firstNonEmptyLine(finding.details);
  if (detailsLine) return ensureTerminalSentence(detailsLine);
  const title = normalizeInlineText(finding.title);
  if (!title) return "This feedback is tied to the related summary finding.";
  return ensureTerminalSentence(`This feedback is about ${stripTerminalPunctuation(title)}`);
}

function firstNonEmptyLine(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .split(/\r?\n/)
    .map((line) => normalizeInlineText(line))
    .find((line) => line.length > 0);
}

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripTerminalPunctuation(value: string): string {
  return value.replace(/[.?!:;,]+$/g, "").trim();
}

function ensureTerminalSentence(value: string): string {
  const cleaned = normalizeInlineText(value);
  if (!cleaned) return "This feedback is tied to the related summary finding.";
  if (/[.?!]$/.test(cleaned)) return cleaned;
  return `${cleaned}.`;
}

function normalizeFindingRef(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized || !FINDING_REF_PATTERN.test(normalized)) return undefined;
  return normalized;
}

function normalizeFindingPlacement(
  value: string | undefined,
  status: StructuredSummaryFinding["status"]
): SummaryPlacement {
  if (value === "inline" || value === "summary_only") return value;
  return status === "new" ? "inline" : "summary_only";
}

function normalizeObservationCategory(value: string | undefined): SummaryObservation["category"] {
  if (value === "testing" || value === "risk" || value === "architecture") return value;
  return "context";
}

function validateFindingNarrative(input: {
  title: string;
  details?: string;
  action?: string;
}): { ok: true } | { ok: false; message: string } {
  const title = input.title.trim();
  if (META_FINDING_TITLE_PATTERN.test(title)) {
    return {
      ok: false,
      message: "title must describe an issue, not a verification task (avoid prefixes like Verify/Check/Confirm).",
    };
  }
  if (SUMMARY_ONLY_SCOPE_TEXT_PATTERN.test(input.details ?? "")) {
    return {
      ok: false,
      message: "details must describe the issue only; put summary-only scope rationale in summary_only_reason.",
    };
  }
  const combined = `${title} ${input.details ?? ""} ${input.action ?? ""}`.trim();
  if (PRAISE_ONLY_PATTERN.test(combined) && !ISSUE_SIGNAL_PATTERN.test(combined)) {
    return {
      ok: false,
      message: "finding appears praise-only or verification-only; findings must capture concrete risk/impact.",
    };
  }
  return { ok: true };
}

function isBotAuthor(author?: string, authorType?: string): boolean {
  if (authorType?.toLowerCase() === "bot") return true;
  return author?.toLowerCase().endsWith("[bot]") ?? false;
}

function isBotComment(comment: ExistingComment): boolean {
  if (isBotAuthor(comment.author, comment.authorType)) return true;
  if (!comment.authorType && comment.body?.includes(BOT_COMMENT_MARKER)) return true;
  return false;
}

function buildLocationIndex(comments: ExistingComment[]): {
  existingByLocation: Map<string, ExistingComment[]>;
  threadActivityById: Map<number, string>;
  threadLastActorById: Map<number, string>;
  threadLastCommentById: Map<number, { id: number; author?: string; authorType?: string; updatedAt: string }>;
} {
  const map = new Map<string, ExistingComment[]>();
  const activity = new Map<number, string>();
  const lastActorById = new Map<number, string>();
  const lastCommentById = new Map<number, { id: number; author?: string; authorType?: string; updatedAt: string }>();
  for (const comment of comments) {
    if (comment.type !== "review" || !comment.path || !comment.line) continue;
    const rootId = comment.inReplyToId ?? comment.id;
    const lastComment = lastCommentById.get(rootId);
    if (!lastComment || lastComment.updatedAt.localeCompare(comment.updatedAt) < 0) {
      lastCommentById.set(rootId, {
        id: comment.id,
        author: comment.author,
        authorType: comment.authorType,
        updatedAt: comment.updatedAt,
      });
    }
    const lastActivity = activity.get(rootId);
    if (!lastActivity || lastActivity.localeCompare(comment.updatedAt) < 0) {
      activity.set(rootId, comment.updatedAt);
      if (comment.author) {
        lastActorById.set(rootId, comment.author);
      }
    }
    if (comment.inReplyToId) continue;
    const key = `${comment.path}:${comment.line}:${comment.side ?? "RIGHT"}`;
    const list = map.get(key) ?? [];
    list.push(comment);
    map.set(key, list);
  }
  return {
    existingByLocation: map,
    threadActivityById: activity,
    threadLastActorById: lastActorById,
    threadLastCommentById: lastCommentById,
  };
}

function findLatestLocation(
  map: Map<string, ExistingComment[]>,
  activity: Map<number, string>,
  path: string,
  line: number,
  side?: "LEFT" | "RIGHT"
): ExistingComment | undefined {
  const list = side ? map.get(`${path}:${line}:${side}`) : map.get(`${path}:${line}:RIGHT`) ?? map.get(`${path}:${line}:LEFT`);
  if (!list || list.length === 0) return undefined;
  return [...list].sort((a, b) => {
    const aActivity = activity.get(a.id) ?? a.updatedAt;
    const bActivity = activity.get(b.id) ?? b.updatedAt;
    return bActivity.localeCompare(aActivity);
  })[0];
}

function buildThreadIndex(threads: ReviewThreadInfo[]): {
  threadsByLocation: Map<string, ReviewThreadInfo[]>;
  threadsById: Map<number, ReviewThreadInfo>;
  threadsByRootCommentId: Map<number, ReviewThreadInfo>;
} {
  const byLocation = new Map<string, ReviewThreadInfo[]>();
  const byId = new Map<number, ReviewThreadInfo>();
  const byRootCommentId = new Map<number, ReviewThreadInfo>();
  for (const thread of threads) {
    byId.set(thread.id, thread);
    if (thread.rootCommentId) {
      byRootCommentId.set(thread.rootCommentId, thread);
    }
    if (!thread.path || thread.line === null) continue;
    if (thread.side) {
      const sideKey = `${thread.path}:${thread.line}:${thread.side}`;
      const sideList = byLocation.get(sideKey) ?? [];
      sideList.push(thread);
      byLocation.set(sideKey, sideList);
    } else {
      const noSideKey = `${thread.path}:${thread.line}`;
      const noSideList = byLocation.get(noSideKey) ?? [];
      noSideList.push(thread);
      byLocation.set(noSideKey, noSideList);
    }
  }
  return { threadsByLocation: byLocation, threadsById: byId, threadsByRootCommentId: byRootCommentId };
}

function findThreadsAtLocation(
  map: Map<string, ReviewThreadInfo[]>,
  path: string,
  line: number,
  side?: "LEFT" | "RIGHT"
): ReviewThreadInfo[] {
  const noSide = map.get(`${path}:${line}`) ?? [];
  if (side) {
    const withSide = map.get(`${path}:${line}:${side}`) ?? [];
    return [...noSide, ...withSide];
  }
  const right = map.get(`${path}:${line}:RIGHT`) ?? [];
  const left = map.get(`${path}:${line}:LEFT`) ?? [];
  return [...noSide, ...right, ...left];
}

function buildThreadAmbiguityResponse(
  path: string,
  line: number,
  threads: ReviewThreadInfo[],
  side?: "LEFT" | "RIGHT"
): { content: { type: "text"; text: string }[]; details: { id: number } } {
  const header = side
    ? `Multiple threads exist at ${path}:${line} for side ${side}.`
    : `Threads exist at ${path}:${line}. You must choose how to proceed.`;
  const guidance = side
    ? "Pick a thread_id from the list below to reply, OR set allow_new_thread=true to create a new thread."
    : "Reply with thread_id, OR specify side (LEFT/RIGHT) to target a single thread, OR set allow_new_thread=true to create a new thread.";
  const formatted = threads
    .map(
      (thread) =>
        `- thread_id=${thread.id} root_comment_id=${thread.rootCommentId ?? "unknown"} side=${thread.side ?? "unknown"} resolved=${thread.resolved} outdated=${thread.isOutdated} last=${thread.lastUpdatedAt} actor=${thread.lastActor}`
    )
    .join("\n");
  return {
    content: [{ type: "text", text: `${header}\n${guidance}\n${formatted}` }],
    details: { id: -1 },
  };
}

function lineExistsInDiff(
  patch: string | undefined,
  line: number,
  side?: "LEFT" | "RIGHT"
): { ok: boolean; message: string } {
  if (!patch) {
    return {
      ok: false,
      message: "No diff available for this file. It may be binary or too large to diff; avoid inline comments.",
    };
  }
  if (!side) {
    return {
      ok: false,
      message: "Missing side (LEFT or RIGHT). Specify side to validate the diff line.",
    };
  }
  const matches = lineInPatch(patch, line, side);
  if (!matches) {
    return {
      ok: false,
      message: `Line ${line} is not present on ${side} side of the diff for this file. Use get_diff to find a valid line.`,
    };
  }
  return { ok: true, message: "ok" };
}

function lineInPatch(patch: string, targetLine: number, side: "LEFT" | "RIGHT"): boolean {
  const lines = patch.split(/\r?\n/);
  let oldLine = 0;
  let newLine = 0;
  for (const line of lines) {
    const header = line.match(/^@@ -(\d+),?\d* \+(\d+),?\d* @@/);
    if (header) {
      oldLine = Number.parseInt(header[1], 10);
      newLine = Number.parseInt(header[2], 10);
      continue;
    }
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+")) {
      if (side === "RIGHT" && newLine === targetLine) return true;
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      if (side === "LEFT" && oldLine === targetLine) return true;
      oldLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      if (side === "RIGHT" && newLine === targetLine) return true;
      if (side === "LEFT" && oldLine === targetLine) return true;
      oldLine += 1;
      newLine += 1;
      continue;
    }
  }
  return false;
}
function ensureSummaryFooter(
  body: string,
  modelId: string,
  billing: { input: number; output: number; total: number; cost: number },
  reviewSha: string
): string {
  const hasFooter = body.includes("Reviewed by shitty-reviewing-agent");
  const billingLine = `*Billing: input ${billing.input} • output ${billing.output} • total ${billing.total} • cost $${billing.cost.toFixed(6)}*`;
  const marker = `<!-- sri:last-reviewed-sha:${reviewSha} -->`;
  const footer = `---\n*Reviewed by shitty-reviewing-agent • model: ${modelId}*\n${billingLine}\n${BOT_COMMENT_MARKER}\n${marker}`;
  if (hasFooter) {
    if (body.includes("Billing: input")) {
      let updated = body;
      if (!updated.includes(BOT_COMMENT_MARKER)) {
        updated = `${updated}\n${BOT_COMMENT_MARKER}`;
      }
      return updated.includes("sri:last-reviewed-sha") ? updated : `${updated}\n${marker}`;
    }
    let updated = `${body}\n${billingLine}`;
    if (!updated.includes(BOT_COMMENT_MARKER)) {
      updated = `${updated}\n${BOT_COMMENT_MARKER}`;
    }
    return updated.includes("sri:last-reviewed-sha") ? updated : `${updated}\n${marker}`;
  }
  return `${body.trim()}\n\n${footer}`;
}

function shouldUpdateDuplicateBot(actor?: string, thread?: ReviewThreadInfo, authorType?: string): boolean {
  if (!actor && !authorType) return false;
  const isBot = isBotAuthor(actor, authorType);
  const unresolved = thread?.resolved !== true;
  return isBot && unresolved;
}

function getLatestThreadComment(
  rootCommentId: number | null,
  lastCommentById: Map<number, { id: number; author?: string; authorType?: string; updatedAt: string }>,
  fallbackAuthor?: string,
  fallbackAuthorType?: string
): { id: number; author?: string; authorType?: string } | null {
  if (!rootCommentId) return null;
  const latest = lastCommentById.get(rootCommentId);
  if (latest) {
    return { id: latest.id, author: latest.author, authorType: latest.authorType };
  }
  return { id: rootCommentId, author: fallbackAuthor, authorType: fallbackAuthorType };
}

function buildDuplicateUpdateResponse(
  path: string,
  line: number,
  commentId: number,
  actor?: string,
  threadId?: number
): { content: { type: "text"; text: string }[]; details: { id: number } } {
  const location = `${path}:${line}`;
  const actorLabel = actor ?? "unknown";
  const threadLabel = threadId ? ` thread=${threadId}` : "";
  return {
    content: [{
      type: "text",
      text: `Latest unresolved comment at ${location}${threadLabel} is by ${actorLabel}. Use update_comment with comment_id=${commentId}.`,
    }],
    details: { id: -1 },
  };
}

function validateSummaryFindings(
  findings: StructuredSummaryFinding[],
  findingLinksByRef: Map<string, FindingLink[]>
): { ok: true } | { ok: false; message: string } {
  const missingRefs = findings.filter((finding) => !finding.findingRef);
  if (missingRefs.length > 0) {
    return {
      ok: false,
      message: "Every report_finding entry must include finding_ref.",
    };
  }
  const missingSummaryOnlyReason = findings.filter(
    (finding) => finding.placement === "summary_only" && !finding.summaryOnlyReason?.trim()
  );
  if (missingSummaryOnlyReason.length > 0) {
    const refs = missingSummaryOnlyReason.map((finding) => finding.findingRef).filter(Boolean).join(", ");
    return {
      ok: false,
      message: `summary_only findings require summary_only_reason. Missing: ${refs || "unknown"}.`,
    };
  }
  const invalidSummaryOnlyMetaReasons = findings.filter((finding) => {
    if (finding.placement !== "summary_only") return false;
    const findingRef = finding.findingRef ?? "";
    const links = findingLinksByRef.get(findingRef) ?? [];
    if (links.length > 0) return false;
    return isMetaSummaryOnlyReason(finding.summaryOnlyReason);
  });
  if (invalidSummaryOnlyMetaReasons.length > 0) {
    const refs = invalidSummaryOnlyMetaReasons.map((finding) => finding.findingRef).filter(Boolean).join(", ");
    return {
      ok: false,
      message:
        `summary_only_reason must explain why no inline anchor is possible (cross-file, no line-specific diff, or non-commentable file), not verification bookkeeping. Update: ${refs || "unknown"}.`,
    };
  }
  const lineAnchoredSummaryOnly = findings.filter((finding) => {
    if (finding.status === "resolved") return false;
    if (finding.placement !== "summary_only") return false;
    const findingRef = finding.findingRef ?? "";
    const links = findingLinksByRef.get(findingRef) ?? [];
    if (links.length > 0) return false;
    const anchors = parseEvidenceAnchors(finding.evidence);
    const anchoredPaths = new Set(anchors.map((anchor) => anchor.path));
    const hasLineAnchors = anchors.some((anchor) => anchor.line > 0);
    const singlePathLineAnchored = hasLineAnchors && anchoredPaths.size === 1;
    if (!singlePathLineAnchored) return false;
    return !hasSummaryOnlyScopeHint(finding.summaryOnlyReason);
  });
  if (lineAnchoredSummaryOnly.length > 0) {
    const refs = lineAnchoredSummaryOnly.map((finding) => finding.findingRef).filter(Boolean).join(", ");
    return {
      ok: false,
      message:
        `Line-anchored unresolved findings must have linked inline comments/suggestions. Add comment/suggest with matching finding_ref, or justify summary_only_reason with explicit scope limits. Missing links: ${refs || "unknown"}.`,
    };
  }
  const missingInlineLinks = findings
    .filter((finding) => finding.status !== "resolved" && finding.placement !== "summary_only")
    .filter((finding) => {
      const findingRef = finding.findingRef ?? "";
      const links = findingLinksByRef.get(findingRef) ?? [];
      return links.length === 0;
    });
  if (missingInlineLinks.length > 0) {
    const refs = missingInlineLinks.map((finding) => finding.findingRef).filter(Boolean).join(", ");
    return {
      ok: false,
      message:
        `Unresolved inline findings are missing linked comments/suggestions. Add finding_ref to comment/suggest or mark placement=summary_only with summary_only_reason. Missing links: ${refs || "unknown"}.`,
    };
  }
  return { ok: true };
}

function hasSummaryOnlyScopeHint(reason: string | undefined): boolean {
  const text = (reason ?? "").trim();
  if (!text) return false;
  return SUMMARY_ONLY_REASON_HINT_PATTERNS.some((pattern) => pattern.test(text));
}

function isMetaSummaryOnlyReason(reason: string | undefined): boolean {
  const text = (reason ?? "").trim();
  if (!text) return false;
  return SUMMARY_ONLY_META_REASON_PATTERNS.some((pattern) => pattern.test(text));
}

function parseEvidenceAnchors(evidence: string[] | undefined): Array<{ path: string; line: number }> {
  if (!evidence || evidence.length === 0) return [];
  const anchors: Array<{ path: string; line: number }> = [];
  for (const entry of evidence) {
    const normalized = entry.trim().replace(/^`+|`+$/g, "");
    const match = normalized.match(EVIDENCE_FILE_LINE_PATTERN);
    if (!match) continue;
    const line = Number.parseInt(match[2], 10);
    if (!Number.isFinite(line) || line <= 0) continue;
    anchors.push({ path: match[1], line });
  }
  return anchors;
}

function resolveSummaryKeyFiles(
  changedFiles: ChangedFile[],
  reportedKeyFiles: KeyFileSummary[]
): KeyFileSummary[] {
  const validPaths = new Set(changedFiles.map((file) => file.filename));
  const merged: KeyFileSummary[] = [];
  const seen = new Set<string>();

  for (const reported of reportedKeyFiles) {
    if (!reported.path || !validPaths.has(reported.path) || seen.has(reported.path)) continue;
    seen.add(reported.path);
    merged.push({
      path: reported.path,
      whyReview: reported.whyReview?.trim() || "n/a",
      whatFileDoes: reported.whatFileDoes?.trim() || "n/a",
      whatChanged: reported.whatChanged?.trim() || buildAutoKeyFileSummary(changedFiles, reported.path),
      whyChanged: reported.whyChanged?.trim() || "n/a",
      reviewChecklist: (reported.reviewChecklist ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 5),
      impactMap: reported.impactMap?.trim() || undefined,
    });
  }
  return merged.slice(0, 6);
}

function buildAutoKeyFileSummary(changedFiles: ChangedFile[], path: string): string {
  const file = changedFiles.find((item) => item.filename === path);
  if (!file) return "n/a";
  const additions = Number.isFinite(file.additions) ? file.additions : 0;
  const deletions = Number.isFinite(file.deletions) ? file.deletions : 0;
  const base = `${file.status} (+${additions}/-${deletions})`;
  if (file.status === "renamed" && file.previous_filename) {
    return `${base}, renamed from ${file.previous_filename}`;
  }
  return base;
}

function formatFindingLinks(links: FindingLink[] | undefined): string[] {
  if (!links || links.length === 0) return [];
  return links.map((link) => {
    const label = `${link.path}:${link.line} (${link.side}, ${link.kind})`;
    if (link.commentUrl) return `[${label}](${link.commentUrl})`;
    return `${label}, comment ${link.commentId}`;
  });
}

function normalizeVerdict(value: string | undefined): "Request Changes" | "Approve" | "Skipped" | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "request changes") return "Request Changes";
  if (normalized === "approve") return "Approve";
  if (normalized === "skipped") return "Skipped";
  return null;
}

function inferVerdict(findings: StructuredSummaryFinding[]): "Request Changes" | "Approve" {
  if (findings.some((finding) => finding.status !== "resolved")) {
    return "Request Changes";
  }
  return "Approve";
}

function validateSummaryVerdict(
  verdict: "Request Changes" | "Approve" | "Skipped",
  findings: StructuredSummaryFinding[]
): { ok: true } | { ok: false; message: string } {
  if (verdict === "Approve" && findings.some((finding) => finding.status !== "resolved" && finding.severity !== "low")) {
    return {
      ok: false,
      message: "Verdict Approve conflicts with unresolved medium/high findings. Use Request Changes or lower severity after reassessment.",
    };
  }
  return { ok: true };
}

async function safeCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    if (error?.status === 403 && error?.message?.toLowerCase().includes("rate limit")) {
      throw new RateLimitError("GitHub API rate limit exceeded.");
    }
    throw error;
  }
}

function isIntegrationAccessError(error: any): boolean {
  const message = String(error?.message ?? "");
  if (/resource not accessible by integration/i.test(message)) return true;
  if (error?.status === 403 && /forbidden|not authorized|insufficient scopes/i.test(message)) return true;
  const graphqlErrors = error?.errors ?? error?.data?.errors;
  if (Array.isArray(graphqlErrors)) {
    return graphqlErrors.some((item) => /resource not accessible by integration/i.test(String(item?.message ?? "")));
  }
  return false;
}

function isLikelyWrongCommentType(error: any): boolean {
  const status = error?.status;
  if (status === 404 || status === 422) return true;
  const message = String(error?.message ?? "");
  if (/not found/i.test(message)) return true;
  if (/unprocessable|validation/i.test(message)) return true;
  return false;
}
