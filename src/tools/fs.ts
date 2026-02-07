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

  const validateMermaidTool: AgentTool<typeof ValidateMermaidSchema, {
    valid: boolean;
    diagramType: string | null;
    errors: string[];
    warnings: string[];
  }> = {
    name: "validate_mermaid",
    label: "Validate Mermaid diagram",
    description: "Validate Mermaid syntax using Mermaid's parser plus lightweight structural checks.",
    parameters: ValidateMermaidSchema,
    execute: async (_id, params) => {
      const result = await validateMermaidDiagram(params.diagram);
      const summary = [
        `valid: ${result.valid}`,
        `diagram_type: ${result.diagramType ?? "unknown"}`,
        result.errors.length > 0 ? `errors:\n${result.errors.map((error) => `- ${error}`).join("\n")}` : "errors:\n- none",
        result.warnings.length > 0 ? `warnings:\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}` : "warnings:\n- none",
      ].join("\n");
      return {
        content: [{ type: "text", text: summary }],
        details: result,
      };
    },
  };

  return [readTool, grepTool, findTool, lsTool, validateMermaidTool];
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

const ValidateMermaidSchema = Type.Object({
  diagram: Type.String({ description: "Mermaid diagram source (raw or fenced)." }),
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

async function validateMermaidDiagram(diagram: string): Promise<{
  valid: boolean;
  diagramType: string | null;
  errors: string[];
  warnings: string[];
}> {
  const normalized = extractMermaidSource(diagram);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!normalized) {
    return {
      valid: false,
      diagramType: null,
      errors: ["Diagram is empty."],
      warnings,
    };
  }

  const lines = normalized.split(/\r?\n/);
  const firstLine = lines.find((line) => line.trim().length > 0)?.trim() ?? "";
  let diagramType = detectMermaidType(firstLine);
  try {
    const mermaid = await import("mermaid");
    const parseResult = await mermaid.default.parse(normalized, { suppressErrors: false });
    diagramType = parseResult?.diagramType ?? diagramType;
  } catch (error: any) {
    errors.push(formatMermaidParseError(error));
  }

  if (/\t/.test(normalized)) {
    warnings.push("Diagram contains tab characters; Mermaid is usually safer with spaces.");
  }

  errors.push(...checkBalancedPairs(normalized, "(", ")", "parentheses"));
  errors.push(...checkBalancedPairs(normalized, "[", "]", "square brackets"));
  errors.push(...checkBalancedPairs(normalized, "{", "}", "curly braces"));

  if (diagramType === "sequenceDiagram" && !/(->>|-->>|->|-->|<--|<<--|x->|->x)/.test(normalized)) {
    warnings.push("Sequence diagram has no obvious message arrows.");
  }

  if (lines.length < 2) {
    warnings.push("Diagram has very few lines; verify it includes intended relationships.");
  }

  return {
    valid: errors.length === 0,
    diagramType,
    errors,
    warnings,
  };
}

function extractMermaidSource(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const fencedMermaid = trimmed.match(/```mermaid\s*([\s\S]*?)```/i);
  if (fencedMermaid?.[1]) return fencedMermaid[1].trim();
  const fenced = trimmed.match(/```\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  return trimmed;
}

function detectMermaidType(firstLine: string): string | null {
  const line = firstLine.trim();
  const known: Array<{ type: string; pattern: RegExp }> = [
    { type: "sequenceDiagram", pattern: /^sequenceDiagram\b/i },
    { type: "flowchart", pattern: /^flowchart\b/i },
    { type: "graph", pattern: /^graph\b/i },
    { type: "classDiagram", pattern: /^classDiagram\b/i },
    { type: "stateDiagram-v2", pattern: /^stateDiagram-v2\b/i },
    { type: "stateDiagram", pattern: /^stateDiagram\b/i },
    { type: "erDiagram", pattern: /^erDiagram\b/i },
    { type: "journey", pattern: /^journey\b/i },
    { type: "gantt", pattern: /^gantt\b/i },
    { type: "pie", pattern: /^pie\b/i },
    { type: "mindmap", pattern: /^mindmap\b/i },
    { type: "timeline", pattern: /^timeline\b/i },
    { type: "gitGraph", pattern: /^gitGraph\b/i },
    { type: "requirementDiagram", pattern: /^requirementDiagram\b/i },
    { type: "quadrantChart", pattern: /^quadrantChart\b/i },
    { type: "xychart-beta", pattern: /^xychart-beta\b/i },
    { type: "block-beta", pattern: /^block-beta\b/i },
    { type: "sankey-beta", pattern: /^sankey-beta\b/i },
    { type: "packet-beta", pattern: /^packet-beta\b/i },
    { type: "C4Context", pattern: /^C4Context\b/i },
    { type: "C4Container", pattern: /^C4Container\b/i },
    { type: "C4Component", pattern: /^C4Component\b/i },
    { type: "C4Dynamic", pattern: /^C4Dynamic\b/i },
    { type: "C4Deployment", pattern: /^C4Deployment\b/i },
  ];
  for (const candidate of known) {
    if (candidate.pattern.test(line)) return candidate.type;
  }
  return null;
}

function checkBalancedPairs(input: string, openChar: string, closeChar: string, label: string): string[] {
  let depth = 0;
  for (const char of input) {
    if (char === openChar) depth += 1;
    if (char === closeChar) depth -= 1;
    if (depth < 0) {
      return [`Unbalanced ${label}: found '${closeChar}' before matching '${openChar}'.`];
    }
  }
  if (depth !== 0) {
    return [`Unbalanced ${label}: missing '${closeChar}'.`];
  }
  return [];
}

function formatMermaidParseError(error: any): string {
  const message = String(error?.message ?? error ?? "").trim();
  return message || "Mermaid parser rejected the diagram.";
}
