import path from "node:path";
import { minimatch } from "minimatch";
import type { IncludeExclude } from "../types.js";

const BLOCKED_PATHS = [".github/workflows/**", ".reviewerc"];

export function assertWriteAllowed(targetPath: string, scope?: IncludeExclude): void {
  const verdict = checkWriteAllowed(targetPath, scope);
  if (!verdict.allowed) {
    throw new Error(`Write blocked for ${targetPath}: ${verdict.reason}`);
  }
}

export function checkWriteAllowed(targetPath: string, scope?: IncludeExclude): { allowed: boolean; reason?: string } {
  const normalized = normalizePath(targetPath);
  if (BLOCKED_PATHS.some((pattern) => minimatch(normalized, pattern))) {
    return { allowed: false, reason: "path is blocked by safety guardrail" };
  }
  const include = scope?.include ?? [];
  const exclude = scope?.exclude ?? [];
  if (include.length > 0 && !include.some((pattern) => minimatch(normalized, pattern))) {
    return { allowed: false, reason: "path is outside writeScope.include" };
  }
  if (exclude.length > 0 && exclude.some((pattern) => minimatch(normalized, pattern))) {
    return { allowed: false, reason: "path is excluded by writeScope.exclude" };
  }
  return { allowed: true };
}

export function normalizePath(value: string): string {
  const posix = value.replace(/\\/g, "/");
  const normalized = path.posix.normalize(posix);
  return normalized.replace(/^(\.\/)+/, "").replace(/^\/+/, "");
}

export function listBlockedPaths(paths: string[], scope?: IncludeExclude): string[] {
  return paths.filter((file) => !checkWriteAllowed(file, scope).allowed);
}
