import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function createGitHistoryTools(repoRoot: string): AgentTool<any>[] {
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
    description: "Run read-only git subcommands (log/show/diff/etc). Args must start with the subcommand.",
    parameters: GitCommandSchema,
    execute: async (_id, params) => {
      validateGitArgs(params.args);
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

const DISALLOWED_ARG_PREFIXES = [
  "--git-dir=",
  "--work-tree=",
  "--exec-path=",
  "-C",
  "--output=",
  "--config=",
  "--config-env=",
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
]);

function validateGitArgs(args: string[]): void {
  if (args.length === 0) {
    throw new Error("git args must include a subcommand");
  }
  const subcommand = args[0];
  if (!READ_ONLY_SUBCOMMANDS.has(subcommand)) {
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
}
