import { test, expect } from "bun:test";
import { buildAdaptiveSummaryMarkdown, buildSummaryMarkdown } from "../src/summary.ts";
import { buildUserPrompt } from "../src/prompts/review.ts";

test("buildSummaryMarkdown adds footer + marker", () => {
  const body = buildSummaryMarkdown({
    verdict: "Approve",
    issues: ["None"],
    keyFindings: ["None"],
    multiFileSuggestions: ["None"],
    model: "test-model",
    reviewSha: "abc1234",
    billing: { input: 1, output: 2, total: 3, cost: 0.001 },
  });

  expect(body).toContain("Reviewed by shitty-reviewing-agent");
  expect(body).toContain("sri:bot-comment");
  expect(body).toContain("sri:last-reviewed-sha:abc1234");
  expect(body).toContain("Billing: input 1");
});

test("buildUserPrompt includes context", () => {
  const prompt = buildUserPrompt({
    prTitle: "Test",
    prBody: "Body",
    changedFiles: ["src/index.ts"],
    maxFiles: 50,
    ignorePatterns: ["*.lock"],
    existingComments: 3,
    lastReviewedSha: "deadbeef",
    headSha: "cafebabe",
  });

  expect(prompt).toContain("Existing PR comments");
  expect(prompt).toContain("Last reviewed SHA: deadbeef");
  expect(prompt).toContain("Current head SHA: cafebabe");
});

test("buildUserPrompt adds follow-up note when prior review exists", () => {
  const prompt = buildUserPrompt({
    prTitle: "Test",
    prBody: "Body",
    changedFiles: ["src/index.ts"],
    maxFiles: 50,
    ignorePatterns: ["*.lock"],
    existingComments: 1,
    lastReviewedSha: "deadbeef",
    headSha: "cafebabe",
    previousVerdict: "Approve",
    previousReviewAt: "2026-01-01T00:00:00Z",
    previousReviewUrl: "https://example.com/review/1",
  });

  expect(prompt).toContain("Note: This is a follow-up review.");
  expect(prompt).toContain("Focus only on changes since the last review");
});

test("buildUserPrompt omits follow-up note for skipped prior run without sha", () => {
  const prompt = buildUserPrompt({
    prTitle: "Test",
    prBody: "Body",
    changedFiles: ["src/index.ts"],
    maxFiles: 50,
    ignorePatterns: ["*.lock"],
    existingComments: 1,
    lastReviewedSha: null,
    headSha: "cafebabe",
    previousVerdict: "Skipped",
    previousReviewAt: "2026-01-01T00:00:00Z",
    previousReviewUrl: "https://example.com/review/1",
  });

  expect(prompt).not.toContain("Note: This is a follow-up review.");
});

test("buildUserPrompt includes deterministic summary metadata", () => {
  const prompt = buildUserPrompt({
    prTitle: "Small follow-up",
    prBody: "Tiny patch",
    changedFiles: ["src/auth/token.ts"],
    maxFiles: 50,
    ignorePatterns: ["*.lock"],
    existingComments: 2,
    lastReviewedSha: "deadbeef",
    headSha: "cafebabe",
    previousVerdict: "Request Changes",
    previousReviewAt: "2026-01-02T00:00:00Z",
    previousReviewUrl: "https://example.com/review/2",
    changedLineCount: 12,
    summaryModeCandidate: "compact",
    riskHints: ["authentication/authorization surface: src/auth/token.ts"],
  });

  expect(prompt).toContain("Deterministic summary mode candidate: compact");
  expect(prompt).toContain("Deterministic risk hints");
  expect(prompt).toContain("set_summary_mode only to escalate");
});

test("buildAdaptiveSummaryMarkdown omits category table for sparse findings", () => {
  const summary = buildAdaptiveSummaryMarkdown({
    verdict: "Request Changes",
    preface: "Two targeted issues were found.",
    mode: "standard",
    isFollowUp: false,
    findings: [
      {
        category: "Bug",
        severity: "medium",
        status: "new",
        title: "Null path check is missing",
      },
      {
        category: "Design",
        severity: "low",
        status: "new",
        title: "New helper leaks storage concerns into API layer",
      },
    ],
  });

  expect(summary).toContain("### Findings");
  expect(summary).not.toContain("### Issue Categories");
  expect(summary).toContain("#### Bug (1)");
  expect(summary).toContain("#### Design (1)");
});

test("buildAdaptiveSummaryMarkdown returns compact short summary for empty follow-up", () => {
  const summary = buildAdaptiveSummaryMarkdown({
    verdict: "Approve",
    mode: "compact",
    isFollowUp: true,
    findings: [],
  });

  expect(summary).toContain("**Verdict:** Approve");
  expect(summary).not.toContain("### New Issues Since Last Review");
  expect(summary).toContain("No new issues, resolutions, or still-open items");
});

test("buildAdaptiveSummaryMarkdown elevates to alert for high-risk findings", () => {
  const summary = buildAdaptiveSummaryMarkdown({
    verdict: "Request Changes",
    mode: "compact",
    isFollowUp: true,
    findings: [
      {
        category: "Security",
        severity: "high",
        status: "new",
        title: "Auth token accepted without audience validation",
        evidence: ["src/auth/token.ts:44"],
        action: "Validate token audience before trust decisions.",
      },
    ],
  });

  expect(summary).toContain("HIGH-RISK CHANGE DETECTED");
  expect(summary).toContain("### Top Risks");
  expect(summary).toContain("### Required Action");
});

test("buildAdaptiveSummaryMarkdown keeps compact follow-up findings terse", () => {
  const summary = buildAdaptiveSummaryMarkdown({
    verdict: "Request Changes",
    mode: "compact",
    isFollowUp: true,
    findings: [
      {
        category: "Bug",
        severity: "medium",
        status: "new",
        title: "Retry loop never stops on permanent 4xx responses",
        details: "Error classification ignores retryability flags.",
        evidence: ["src/retry.ts:88"],
        action: "Gate retries with retryable classification and terminal code checks.",
      },
    ],
  });

  expect(summary).toContain("#### Bug (1)");
  expect(summary).toContain("[medium] Retry loop never stops on permanent 4xx responses");
  expect(summary).not.toContain("evidence:");
  expect(summary).not.toContain("action:");
});

test("buildAdaptiveSummaryMarkdown uses richer standard follow-up output", () => {
  const summary = buildAdaptiveSummaryMarkdown({
    verdict: "Request Changes",
    mode: "standard",
    isFollowUp: true,
    findings: [
      {
        category: "Bug",
        severity: "medium",
        status: "new",
        title: "Retry loop never stops on permanent 4xx responses",
        details: "Error classification ignores retryability flags.",
        evidence: ["src/retry.ts:88"],
        action: "Gate retries with retryable classification and terminal code checks.",
      },
      {
        category: "Design",
        severity: "low",
        status: "still_open",
        title: "Retry policy leaks transport-level details into caller API",
      },
    ],
  });

  expect(summary).toContain("### Issue Categories");
  expect(summary).toContain("evidence: src/retry.ts:88");
  expect(summary).toContain("next step: Gate retries");
});

test("buildAdaptiveSummaryMarkdown renders finding refs and linkage details", () => {
  const summary = buildAdaptiveSummaryMarkdown({
    verdict: "Request Changes",
    mode: "standard",
    isFollowUp: false,
    findings: [
      {
        findingRef: "bug-retry-loop",
        category: "Bug",
        severity: "medium",
        status: "new",
        placement: "inline",
        linkedLocations: ["src/retry.ts:88 (RIGHT, comment, comment 55)"],
        title: "Retry loop never stops on permanent 4xx responses",
      },
      {
        findingRef: "design-boundary-leak",
        category: "Design",
        severity: "low",
        status: "still_open",
        placement: "summary_only",
        summaryOnlyReason: "No single line anchor in this update.",
        title: "Service boundary remains coupled to transport DTOs",
      },
    ],
  });

  expect(summary).toContain("(ref: bug-retry-loop)");
  expect(summary).toContain("inline comments: src/retry.ts:88 (RIGHT, comment, comment 55)");
  expect(summary).toContain("(ref: design-boundary-leak)");
  expect(summary).toContain("summary-only scope: No single line anchor in this update.");
});

test("buildAdaptiveSummaryMarkdown favors details for verification-style titles", () => {
  const summary = buildAdaptiveSummaryMarkdown({
    verdict: "Request Changes",
    mode: "standard",
    isFollowUp: false,
    findings: [
      {
        findingRef: "upsert-logic-check",
        category: "Design",
        severity: "low",
        status: "new",
        placement: "summary_only",
        summaryOnlyReason: "cross-file design concern",
        title: "Verify report_finding upsert logic",
        details: "Upsert collisions can overwrite prior findings when refs are reused.",
      },
    ],
  });

  expect(summary).toContain("[low] Upsert collisions can overwrite prior findings when refs are reused.");
  expect(summary).toContain("Design impact: Upsert collisions can overwrite prior findings when refs are reused.");
});
