import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { IncludeExclude } from "../types.js";
import { assertWriteAllowed, normalizePath } from "../app/write-scope.js";

function ensureInsideRoot(root: string, target: string): string {
  const resolved = path.resolve(root, target);
  const normalizedRoot = path.resolve(root) + path.sep;
  if (!resolved.startsWith(normalizedRoot)) {
    throw new Error(`Path escapes repo root: ${target}`);
  }
  return resolved;
}

function assertRelativePath(target: string): void {
  if (path.isAbsolute(target) || target.startsWith("~/") || target.startsWith("~\\")) {
    throw new Error(`Absolute paths are not allowed: ${target}`);
  }
}

export function createRepoWriteTools(repoRoot: string, scope?: IncludeExclude): AgentTool<any>[] {
  const writeFileTool: AgentTool<typeof WriteFileSchema, { path: string }> = {
    name: "write_file",
    label: "Write file",
    description: "Write a file to disk (overwrites).",
    parameters: WriteFileSchema,
    execute: async (_id, params) => {
      const rawPath = params.path;
      assertRelativePath(rawPath);
      const targetPath = normalizePath(rawPath);
      assertWriteAllowed(targetPath, scope);
      const resolved = ensureInsideRoot(repoRoot, targetPath);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, params.content, "utf8");
      const summary = await getRepoSummary(repoRoot);
      return {
        content: [{ type: "text", text: `Wrote ${params.path}` }],
        details: { path: params.path, ...summary },
      };
    },
  };

  const deleteFileTool: AgentTool<typeof DeleteFileSchema, { path: string }> = {
    name: "delete_file",
    label: "Delete file",
    description: "Delete a file from disk.",
    parameters: DeleteFileSchema,
    execute: async (_id, params) => {
      const rawPath = params.path;
      assertRelativePath(rawPath);
      const targetPath = normalizePath(rawPath);
      assertWriteAllowed(targetPath, scope);
      const resolved = ensureInsideRoot(repoRoot, targetPath);
      await fs.unlink(resolved);
      const summary = await getRepoSummary(repoRoot);
      return {
        content: [{ type: "text", text: `Deleted ${params.path}` }],
        details: { path: params.path, ...summary },
      };
    },
  };

  const mkdirTool: AgentTool<typeof MkdirSchema, { path: string }> = {
    name: "mkdir",
    label: "Create directory",
    description: "Create a directory (and parents if needed).",
    parameters: MkdirSchema,
    execute: async (_id, params) => {
      const rawPath = params.path;
      assertRelativePath(rawPath);
      const targetPath = normalizePath(rawPath);
      assertWriteAllowed(targetPath, scope);
      const resolved = ensureInsideRoot(repoRoot, targetPath);
      await fs.mkdir(resolved, { recursive: true });
      const summary = await getRepoSummary(repoRoot);
      return {
        content: [{ type: "text", text: `Created ${params.path}` }],
        details: { path: params.path, ...summary },
      };
    },
  };

  const applyPatchTool: AgentTool<typeof ApplyPatchSchema, { applied: boolean }> = {
    name: "apply_patch",
    label: "Apply patch",
    description: "Apply a unified diff patch.",
    parameters: ApplyPatchSchema,
    execute: async (_id, params) => {
      await runGitApply(repoRoot, params.patch, scope);
      const summary = await getRepoSummary(repoRoot);
      return {
        content: [{ type: "text", text: "Patch applied." }],
        details: { applied: true, ...summary },
      };
    },
  };

  return [writeFileTool, deleteFileTool, mkdirTool, applyPatchTool];
}

async function runGitApply(repoRoot: string, patch: string, scope?: IncludeExclude): Promise<void> {
  const touched = extractPatchPaths(patch);
  for (const file of touched) {
    assertRelativePath(file);
    const normalized = normalizePath(file);
    assertWriteAllowed(normalized, scope);
    ensureInsideRoot(repoRoot, normalized);
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["apply", "--whitespace=nowarn"], { cwd: repoRoot });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `git apply failed with code ${code}`));
      }
    });
    child.stdin.write(patch);
    child.stdin.end();
  });
}

async function getRepoSummary(repoRoot: string): Promise<{ status: string[]; diffStat: string }> {
  const [status, diffStat] = await Promise.all([
    runGit(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
    runGit(repoRoot, ["diff", "--stat"]),
  ]);
  return {
    status: status.split(/\r?\n/).filter(Boolean),
    diffStat: diffStat.trim(),
  };
}

async function runGit(repoRoot: string, args: string[]): Promise<string> {
  return await new Promise((resolve) => {
    const child = spawn("git", args, { cwd: repoRoot });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve(""));
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        resolve("");
      }
    });
  });
}

function extractPatchPaths(patch: string): string[] {
  const files = new Set<string>();
  const lines = patch.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith("+++ b/")) {
      files.add(normalizePath(line.replace("+++ b/", "").trim()));
    }
    if (line.startsWith("--- a/")) {
      const file = line.replace("--- a/", "").trim();
      if (file !== "/dev/null") {
        files.add(normalizePath(file));
      }
    }
  }
  return [...files];
}

const WriteFileSchema = Type.Object({
  path: Type.String({ description: "Path relative to repo root" }),
  content: Type.String({ description: "File contents" }),
});

const DeleteFileSchema = Type.Object({
  path: Type.String({ description: "Path relative to repo root" }),
});

const MkdirSchema = Type.Object({
  path: Type.String({ description: "Directory path relative to repo root" }),
});

const ApplyPatchSchema = Type.Object({
  patch: Type.String({ description: "Unified diff patch" }),
});
