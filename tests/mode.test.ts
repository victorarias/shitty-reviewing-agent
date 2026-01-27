import { test, expect } from "bun:test";
import { resolveRunModeFromEvent, shouldHandleIssueComment } from "../src/app/mode.ts";

test("resolveRunModeFromEvent handles pull_request", () => {
  const mode = resolveRunModeFromEvent("pull_request", { pull_request: { number: 5 } });
  expect(mode.mode).toBe("pull_request");
  if (mode.mode === "pull_request") {
    expect(mode.prNumber).toBe(5);
  }
});

test("resolveRunModeFromEvent handles issue_comment for PR", () => {
  const mode = resolveRunModeFromEvent("issue_comment", {
    issue: { number: 7, pull_request: { url: "https://example.com" } },
    comment: { body: "!security" },
  });
  expect(mode.mode).toBe("issue_comment");
  if (mode.mode === "issue_comment") {
    expect(mode.isPullRequest).toBe(true);
    expect(mode.prNumber).toBe(7);
  }
});

test("resolveRunModeFromEvent handles issue_comment for issue", () => {
  const mode = resolveRunModeFromEvent("issue_comment", {
    issue: { number: 8 },
    comment: { body: "!security" },
  });
  expect(mode.mode).toBe("issue_comment");
  if (mode.mode === "issue_comment") {
    expect(mode.isPullRequest).toBe(false);
  }
});

test("shouldHandleIssueComment logs when not PR", () => {
  const mode = resolveRunModeFromEvent("issue_comment", {
    issue: { number: 8 },
    comment: { body: "!security" },
  });
  let message = "";
  const ok = shouldHandleIssueComment(mode, (msg) => {
    message = msg;
  });
  expect(ok).toBe(false);
  expect(message).toContain("Issue comment is not attached to a pull request");
});

test("shouldHandleIssueComment returns true for PR comments", () => {
  const mode = resolveRunModeFromEvent("issue_comment", {
    issue: { number: 9, pull_request: { url: "https://example.com" } },
    comment: { body: "!security" },
  });
  const ok = shouldHandleIssueComment(mode, () => {});
  expect(ok).toBe(true);
});

test("resolveRunModeFromEvent handles schedule", () => {
  const mode = resolveRunModeFromEvent("schedule", {});
  expect(mode.mode).toBe("schedule");
});
