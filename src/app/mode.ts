import * as github from "@actions/github";

export type RunMode =
  | { mode: "pull_request"; prNumber: number }
  | { mode: "issue_comment"; prNumber: number | null; isPullRequest: boolean; commentBody: string }
  | { mode: "schedule" }
  | { mode: "unknown"; eventName: string };

export function resolveRunMode(): RunMode {
  const ctx = github.context;
  return resolveRunModeFromEvent(ctx.eventName, ctx.payload);
}

export function shouldHandleIssueComment(mode: RunMode, logInfo?: (message: string) => void): boolean {
  if (mode.mode !== "issue_comment") return false;
  if (!mode.isPullRequest || !mode.prNumber) {
    logInfo?.("Issue comment is not attached to a pull request. Skipping command execution.");
    return false;
  }
  return true;
}

export function resolveRunModeFromEvent(eventName: string, payload: any): RunMode {
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const prNumber = payload.pull_request?.number ?? payload.issue?.number;
    if (!prNumber) {
      return { mode: "unknown", eventName };
    }
    return { mode: "pull_request", prNumber };
  }

  if (eventName === "issue_comment") {
    const prNumber = payload.issue?.number ?? null;
    const isPullRequest = Boolean(payload.issue?.pull_request);
    const commentBody = payload.comment?.body ?? "";
    return { mode: "issue_comment", prNumber, isPullRequest, commentBody };
  }

  if (eventName === "schedule") {
    return { mode: "schedule" };
  }

  return { mode: "unknown", eventName };
}
