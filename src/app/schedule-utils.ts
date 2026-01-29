import * as github from "@actions/github";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function getCurrentBranch(repoRoot: string): Promise<string> {
  const envRefName = process.env.GITHUB_REF_NAME;
  if (envRefName) return envRefName;
  const envRef = process.env.GITHUB_REF;
  if (envRef && envRef.startsWith("refs/heads/")) {
    return envRef.slice("refs/heads/".length);
  }
  const ctxRef = github.context.ref;
  if (ctxRef && ctxRef.startsWith("refs/heads/")) {
    return ctxRef.slice("refs/heads/".length);
  }
  const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot });
  const branch = stdout.toString().trim();
  if (branch && branch !== "HEAD") return branch;
  return branch || "HEAD";
}

export function buildScheduleBranchName(jobId: string, commandIds: string[]): string {
  const seed = commandIds.length === 1 ? commandIds[0] : `${jobId}-${commandIds.join(",")}`;
  const slug = seed
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-/g, "")
    .slice(0, 32) || "scheduled";
  const hash = crypto.createHash("sha1").update(seed).digest("hex").slice(0, 8);
  return `sra/schedule/${slug}-${hash}`;
}
