import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";

const DEFAULT_EXCLUDES = ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/coverage/**"];

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

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  return sample.includes(0);
}

export function createReadOnlyTools(repoRoot: string): AgentTool<any>[] {
  const readTool: AgentTool<typeof ReadSchema, { path: string; truncated: boolean }> = {
    name: "read",
    label: "Read file",
    description: "Read a file from the repo. Optionally specify start/end line numbers.",
    parameters: ReadSchema,
    execute: async (_id, params) => {
      const target = ensureInsideRoot(repoRoot, params.path);
      const raw = await fs.readFile(target);
      if (looksBinary(raw)) {
        return {
          content: [{ type: "text", text: `Binary file: ${params.path}` }],
          details: { path: params.path, truncated: false },
        };
      }
      const text = raw.toString("utf8");
      const lines = text.split(/\r?\n/);
      const start = Math.max(1, params.start_line ?? 1);
      const end = Math.min(lines.length, params.end_line ?? lines.length);
      const slice = lines.slice(start - 1, end);
      const joined = slice.join("\n");
      const maxChars = params.max_chars ?? 20000;
      const truncated = joined.length > maxChars;
      const isPartial = start !== 1 || end !== lines.length;
      const header = truncated || isPartial
        ? `[read ${params.path}] lines ${start}-${end} of ${lines.length}` +
          (truncated ? ` (truncated at ${maxChars} chars; request smaller ranges to read more)` : "") +
          "\n"
        : "";
      const body = truncated ? joined.slice(0, maxChars) + "\n...<truncated>" : joined;
      const finalText = `${header}${body}`;
      return {
        content: [{ type: "text", text: finalText }],
        details: {
          path: params.path,
          truncated,
          startLine: start,
          endLine: end,
          totalLines: lines.length,
          maxChars,
        },
      };
    },
  };

  const lsTool: AgentTool<typeof LsSchema, { entries: string[]; longEntries?: LsLongEntry[] }> = {
    name: "ls",
    label: "List directory",
    description: "List directory contents. Set long=true for ls -l style metadata in details.longEntries.",
    parameters: LsSchema,
    execute: async (_id, params) => {
      const target = ensureInsideRoot(repoRoot, params.path ?? ".");
      const entries = await fs.readdir(target);
      if (!params.long) {
        return {
          content: [{ type: "text", text: entries.join("\n") }],
          details: { entries },
        };
      }

      const longEntries = await Promise.all(
        entries.map(async (name) => {
          const entryPath = path.join(target, name);
          let stats;
          try {
            stats = await fs.lstat(entryPath);
          } catch {
            return null;
          }
          const type = getEntryType(stats);
          const permissions = formatPermissions(stats, type);
          const targetLink =
            type === "symlink"
              ? await fs.readlink(entryPath).catch(() => null)
              : null;
          return {
            name,
            type,
            mode: stats.mode,
            permissions,
            nlink: stats.nlink,
            uid: stats.uid,
            gid: stats.gid,
            size: stats.size,
            mtime: stats.mtime.toISOString(),
            target: targetLink ?? undefined,
          };
        })
      );

      const filtered = longEntries.filter(Boolean) as LsLongEntry[];
      const lines = filtered.map((entry) => {
        const name = entry.target ? `${entry.name} -> ${entry.target}` : entry.name;
        return `${entry.permissions} ${entry.nlink} ${entry.uid} ${entry.gid} ${entry.size} ${formatLsTime(entry.mtime)} ${name}`;
      });
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { entries, longEntries: filtered },
      };
    },
  };

  const findTool: AgentTool<typeof FindSchema, { files: string[] }> = {
    name: "find",
    label: "Find files",
    description: "Find files by glob pattern.",
    parameters: FindSchema,
    execute: async (_id, params) => {
      const matches = await fg(params.pattern, {
        cwd: repoRoot,
        onlyFiles: true,
        unique: true,
        ignore: DEFAULT_EXCLUDES,
        dot: true,
      });
      const limited = matches.slice(0, params.max_results ?? 200);
      return {
        content: [{ type: "text", text: limited.join("\n") }],
        details: { files: limited },
      };
    },
  };

  const grepTool: AgentTool<typeof GrepSchema, { matches: GrepMatch[] }> = {
    name: "grep",
    label: "Search text",
    description: "Search files for a regex pattern.",
    parameters: GrepSchema,
    execute: async (_id, params) => {
      const regex = new RegExp(params.pattern, params.flags ?? "g");
      const paths = params.paths
        ? params.paths.split(",").map((p) => p.trim()).filter(Boolean)
        : [];
      const globs = params.globs
        ? params.globs.split(",").map((p) => p.trim()).filter(Boolean)
        : [];
      const candidates = paths.length > 0
        ? paths
        : await fg(globs.length > 0 ? globs : "**/*", {
            cwd: repoRoot,
            onlyFiles: true,
            unique: true,
            ignore: DEFAULT_EXCLUDES,
            dot: true,
          });

      const results: GrepMatch[] = [];
      const maxResults = params.max_results ?? 50;

      for (const file of candidates) {
        if (results.length >= maxResults) break;
        const target = ensureInsideRoot(repoRoot, file);
        let raw: Buffer;
        try {
          raw = await fs.readFile(target);
        } catch {
          continue;
        }
        if (looksBinary(raw)) continue;
        const text = raw.toString("utf8");
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (results.length >= maxResults) break;
          if (regex.test(lines[i])) {
            results.push({ path: file, line: i + 1, text: lines[i].slice(0, 400) });
          }
          regex.lastIndex = 0;
        }
      }

      const rendered = results.map((m) => `${m.path}:${m.line} ${m.text}`).join("\n");
      return {
        content: [{ type: "text", text: rendered || "(no matches)" }],
        details: { matches: results },
      };
    },
  };

  return [readTool, grepTool, findTool, lsTool];
}

const ReadSchema = Type.Object({
  path: Type.String({ description: "Path relative to repo root" }),
  start_line: Type.Optional(Type.Integer({ minimum: 1 })),
  end_line: Type.Optional(Type.Integer({ minimum: 1 })),
  max_chars: Type.Optional(Type.Integer({ minimum: 100, maximum: 200000 })),
});

const LsSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory path relative to repo root" })),
  long: Type.Optional(Type.Boolean({ description: "Include ls -l style metadata" })),
});

const FindSchema = Type.Object({
  pattern: Type.String({ description: "Glob pattern" }),
  max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});

const GrepSchema = Type.Object({
  pattern: Type.String({ description: "Regex pattern" }),
  flags: Type.Optional(Type.String({ description: "Regex flags" })),
  globs: Type.Optional(Type.String({ description: "Comma-separated glob patterns" })),
  paths: Type.Optional(Type.String({ description: "Comma-separated file paths" })),
  max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

type LsEntryType = "file" | "dir" | "symlink" | "block" | "char" | "fifo" | "socket" | "unknown";

interface LsLongEntry {
  name: string;
  type: LsEntryType;
  mode: number;
  permissions: string;
  nlink: number;
  uid: number;
  gid: number;
  size: number;
  mtime: string;
  target?: string;
}

function getEntryType(stats: import("node:fs").Stats): LsEntryType {
  if (stats.isDirectory()) return "dir";
  if (stats.isFile()) return "file";
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isBlockDevice()) return "block";
  if (stats.isCharacterDevice()) return "char";
  if (stats.isFIFO()) return "fifo";
  if (stats.isSocket()) return "socket";
  return "unknown";
}

function formatPermissions(stats: import("node:fs").Stats, type: LsEntryType): string {
  const typeChar = type === "dir"
    ? "d"
    : type === "symlink"
      ? "l"
      : type === "block"
        ? "b"
        : type === "char"
          ? "c"
          : type === "fifo"
            ? "p"
            : type === "socket"
              ? "s"
              : "-";
  const mode = stats.mode;
  const perm = (bit: number, char: string) => (mode & bit ? char : "-");
  const usr = `${perm(0o400, "r")}${perm(0o200, "w")}${perm(0o100, "x")}`;
  const grp = `${perm(0o040, "r")}${perm(0o020, "w")}${perm(0o010, "x")}`;
  const oth = `${perm(0o004, "r")}${perm(0o002, "w")}${perm(0o001, "x")}`;
  return `${typeChar}${usr}${grp}${oth}`;
}

function formatLsTime(isoTime: string): string {
  const date = new Date(isoTime);
  if (Number.isNaN(date.getTime())) return isoTime;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}
