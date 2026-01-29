import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { IncludeExclude } from "../types.js";
import { assertWriteAllowed, normalizePath } from "../app/write-scope.js";

const execFileAsync = promisify(execFile);

export function createGitHistoryTools(
  repoRoot: string,
  options: { allowWrite?: boolean; writeScope?: IncludeExclude } = {}
): AgentTool<any>[] {
  const allowWrite = options.allowWrite ?? false;
  const writeScope = options.writeScope;
  const gitLogTool: AgentTool<typeof GitLogSchema, { commits: GitCommit[] }> = {
    name: "git_log",
    label: "Git log",
    description: "List commits within a time window.",
    parameters: GitLogSchema,
    execute: async (_id, params) => {
      const since = `${params.sinceHours} hours ago`;
      const args = ["log", `--since=${since}`, "--date=iso", "--pretty=format:%H\t%an\t%ad\t%s"];
      if (params.paths && params.paths.length > 0) {
        args.push("--", ...params.paths);
      }
      const stdout = await runGit(repoRoot, args);
      const commits = stdout
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [sha, author, date, message] = line.split("\t");
          return { sha, author, date, message };
        });
      return {
        content: [{ type: "text", text: JSON.stringify(commits, null, 2) }],
        details: { commits },
      };
    },
  };

  const gitDiffRangeTool: AgentTool<typeof GitDiffRangeSchema, { diff: string }> = {
    name: "git_diff_range",
    label: "Git diff range",
    description: "Get diff between two refs.",
    parameters: GitDiffRangeSchema,
    execute: async (_id, params) => {
      const args = ["diff", `${params.from}..${params.to}`];
      if (params.paths && params.paths.length > 0) {
        args.push("--", ...params.paths);
      }
      const diff = await runGit(repoRoot, args);
      return {
        content: [{ type: "text", text: diff || "(no diff)" }],
        details: { diff },
      };
    },
  };

  const gitTool: AgentTool<typeof GitCommandSchema, { stdout: string; args: string[] }> = {
    name: "git",
    label: "Git",
    description: "Run git subcommands. Args must start with the subcommand.",
    parameters: GitCommandSchema,
    execute: async (_id, params) => {
      validateGitArgs(params.args, allowWrite, repoRoot, writeScope);
      const args = ["--no-pager", ...params.args];
      const stdout = await runGit(repoRoot, args);
      const text = stdout || "(no output)";
      return {
        content: [{ type: "text", text }],
        details: { stdout, args: params.args },
      };
    },
  };

  return [gitLogTool, gitDiffRangeTool, gitTool];
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout.toString();
  } catch (error: any) {
    const message = error?.stderr?.toString() || error?.message || String(error);
    if (isDubiousOwnershipError(message)) {
      await addSafeDirectory(cwd);
      try {
        const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
        return stdout.toString();
      } catch (retryError: any) {
        const retryMessage = retryError?.stderr?.toString() || retryError?.message || String(retryError);
        throw new Error(`git ${args.join(" ")} failed: ${retryMessage}`);
      }
    }
    throw new Error(`git ${args.join(" ")} failed: ${message}`);
  }
}

function isDubiousOwnershipError(message: string): boolean {
  return /dubious ownership/i.test(message);
}

async function addSafeDirectory(cwd: string): Promise<void> {
  await execFileAsync("git", ["config", "--global", "--add", "safe.directory", path.resolve(cwd)]);
}

const GitLogSchema = Type.Object({
  sinceHours: Type.Number({ minimum: 1, description: "How many hours back to include" }),
  paths: Type.Optional(Type.Array(Type.String({ description: "Optional file paths or globs" }))),
});

const GitDiffRangeSchema = Type.Object({
  from: Type.String({ description: "Git ref for start" }),
  to: Type.String({ description: "Git ref for end" }),
  paths: Type.Optional(Type.Array(Type.String({ description: "Optional file paths or globs" }))),
});

const GitCommandSchema = Type.Object({
  args: Type.Array(Type.String({ description: "Git arguments starting with the subcommand" }), {
    minItems: 1,
  }),
});

interface GitCommit {
  sha: string;
  author: string;
  date: string;
  message: string;
}

const READ_ONLY_SUBCOMMANDS = new Set([
  "log",
  "show",
  "diff",
  "diff-tree",
  "diff-index",
  "diff-files",
  "status",
  "rev-parse",
  "rev-list",
  "cat-file",
  "ls-tree",
  "ls-files",
  "blame",
  "grep",
  "shortlog",
  "show-ref",
  "for-each-ref",
  "name-rev",
  "describe",
  "merge-base",
  "range-diff",
  "whatchanged",
]);

const WRITE_SUBCOMMANDS = new Set(["add", "commit", "checkout", "switch", "config"]);

const DISALLOWED_ARG_PREFIXES = [
  "--git-dir=",
  "--work-tree=",
  "--exec-path=",
  "-C",
  "--output=",
  "--config=",
  "--config-env=",
  "--no-index=",
];
const DISALLOWED_ARGS = new Set([
  "--git-dir",
  "--work-tree",
  "--exec-path",
  "-C",
  "--output",
  "-c",
  "--config",
  "--config-env",
  "--no-index",
]);

function validateGitArgs(
  args: string[],
  allowWrite: boolean,
  repoRoot: string,
  writeScope?: IncludeExclude
): void {
  if (args.length === 0) {
    throw new Error("git args must include a subcommand");
  }
  const subcommand = args[0];
  if (!READ_ONLY_SUBCOMMANDS.has(subcommand) && !WRITE_SUBCOMMANDS.has(subcommand)) {
    throw new Error(`Unsupported git subcommand: ${subcommand}`);
  }
  if (WRITE_SUBCOMMANDS.has(subcommand) && !allowWrite) {
    throw new Error(`Unsupported git subcommand: ${subcommand}`);
  }
  for (const arg of args) {
    if (DISALLOWED_ARGS.has(arg)) {
      throw new Error(`Disallowed git argument: ${arg}`);
    }
    for (const prefix of DISALLOWED_ARG_PREFIXES) {
      if (arg.startsWith(prefix)) {
        throw new Error(`Disallowed git argument: ${arg}`);
      }
    }
  }
  if (WRITE_SUBCOMMANDS.has(subcommand)) {
    validateWriteArgs(subcommand, args.slice(1), repoRoot, writeScope);
  }
}

function validateWriteArgs(
  subcommand: string,
  args: string[],
  repoRoot: string,
  writeScope?: IncludeExclude
): void {
  switch (subcommand) {
    case "add":
      return validateGitAddArgs(args, repoRoot, writeScope);
    case "rm":
      return validateGitRmArgs(args, repoRoot, writeScope);
    case "mv":
      return validateGitMvArgs(args, repoRoot, writeScope);
    case "restore":
      return validateGitRestoreArgs(args, repoRoot, writeScope);
    case "commit":
      return validateGitCommitArgs(args);
    case "config":
      return validateGitConfigArgs(args);
    case "checkout":
      return validateGitCheckoutArgs(args);
    case "switch":
      return validateGitSwitchArgs(args);
    default:
      throw new Error(`Unsupported git subcommand: ${subcommand}`);
  }
}

function validateGitAddArgs(args: string[], repoRoot: string, writeScope?: IncludeExclude): void {
  const paths = extractPathArgs("add", args);
  if (paths.length === 0) {
    throw new Error("git add requires explicit file paths");
  }
  validateWritePaths("add", paths, repoRoot, writeScope);
}

function validateGitCommitArgs(args: string[]): void {
  let message: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--no-verify") {
      continue;
    }
    if (arg === "-m" || arg === "--message") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("git commit requires a message after -m/--message");
      }
      message = value;
      i += 1;
      continue;
    }
    if (arg === "-a" || arg === "--all" || arg === "--amend") {
      throw new Error(`git commit option not allowed: ${arg}`);
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unsupported git commit option: ${arg}`);
    }
    throw new Error(`Unexpected git commit argument: ${arg}`);
  }
  if (!message) {
    throw new Error("git commit requires -m <message>");
  }
}

function validateGitConfigArgs(args: string[]): void {
  let index = 0;
  if (args[index] === "--local") {
    index += 1;
  }
  if (args[index]?.startsWith("-")) {
    throw new Error(`Unsupported git config option: ${args[index]}`);
  }
  const key = args[index];
  const value = args[index + 1];
  if (!key || !value) {
    throw new Error("git config requires a key and value");
  }
  if (!["user.name", "user.email"].includes(key)) {
    throw new Error(`git config only allows user.name or user.email (got ${key})`);
  }
  if (args.length > index + 2) {
    throw new Error("git config accepts only a single key/value pair");
  }
}

function validateGitCheckoutArgs(args: string[]): void {
  if (args.length !== 2 || !["-B", "-b"].includes(args[0])) {
    throw new Error("git checkout only allows -b/-B <branch>");
  }
  if (args[1].startsWith("-") || args[1] === "--") {
    throw new Error("git checkout requires a branch name");
  }
}

function validateGitSwitchArgs(args: string[]): void {
  if (args.length !== 2 || !["-c", "--create"].includes(args[0])) {
    throw new Error("git switch only allows -c/--create <branch>");
  }
  if (args[1].startsWith("-") || args[1] === "--") {
    throw new Error("git switch requires a branch name");
  }
}

function validateGitRmArgs(args: string[], repoRoot: string, writeScope?: IncludeExclude): void {
  const paths = extractPathArgs("rm", args);
  if (paths.length === 0) {
    throw new Error("git rm requires explicit file paths");
  }
  validateWritePaths("rm", paths, repoRoot, writeScope);
}

function validateGitMvArgs(args: string[], repoRoot: string, writeScope?: IncludeExclude): void {
  const paths = extractPathArgs("mv", args);
  if (paths.length < 2) {
    throw new Error("git mv requires a source and destination");
  }
  validateWritePaths("mv", paths, repoRoot, writeScope);
}

function validateGitRestoreArgs(args: string[], repoRoot: string, writeScope?: IncludeExclude): void {
  const paths = extractPathArgs("restore", args);
  if (paths.length === 0) {
    throw new Error("git restore requires explicit file paths");
  }
  validateWritePaths("restore", paths, repoRoot, writeScope);
}

function extractPathArgs(command: string, args: string[]): string[] {
  const paths: string[] = [];
  for (const arg of args) {
    if (arg === "--") {
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unsupported git ${command} option: ${arg}`);
    }
    paths.push(arg);
  }
  return paths;
}

function hasGlob(value: string): boolean {
  return /[*?[\]]/.test(value);
}

function validateWritePaths(
  command: string,
  paths: string[],
  repoRoot: string,
  writeScope?: IncludeExclude
): void {
  for (const target of paths) {
    if (target === "." || target === "./") {
      throw new Error(`git ${command} does not allow '.'; list files explicitly`);
    }
    if (hasGlob(target)) {
      throw new Error(`git ${command} does not allow glob patterns: ${target}`);
    }
    assertRelativePath(target);
    const normalized = normalizePath(target);
    assertWriteAllowed(normalized, writeScope);
    ensureInsideRoot(repoRoot, normalized);
  }
}

function assertRelativePath(target: string): void {
  if (path.isAbsolute(target) || target.startsWith("~/") || target.startsWith("~\\")) {
    throw new Error(`Absolute paths are not allowed: ${target}`);
  }
}

function ensureInsideRoot(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, target);
  const relative = path.relative(resolvedRoot, resolved);
  const isOutside =
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative);
  if (relative === "" || !isOutside) {
    return resolved;
  }
  throw new Error(`Path escapes repo root: ${target}`);
}
