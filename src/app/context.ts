import * as github from "@actions/github";
import type { ReviewContext } from "../types.js";

export function readContext(prNumberOverride?: number): ReviewContext {
  const ctx = github.context;
  const prNumber = prNumberOverride ?? ctx.payload.pull_request?.number ?? ctx.payload.issue?.number;
  if (!prNumber) {
    throw new Error("No pull request found in event payload.");
  }
  return {
    owner: ctx.repo.owner,
    repo: ctx.repo.repo,
    prNumber,
  };
}
