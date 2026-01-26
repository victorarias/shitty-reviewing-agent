import { minimatch } from "minimatch";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChangedFile } from "../types.js";

const execFileAsync = promisify(execFile);
const generatedCache = new Map<string, boolean>();

export function filterIgnoredFiles(files: ChangedFile[], ignorePatterns: string[]): ChangedFile[] {
  if (ignorePatterns.length === 0) return files;
  return files.filter((file) => !ignorePatterns.some((pattern) => minimatch(file.filename, pattern)));
}

export async function filterDiagramFiles(files: ChangedFile[], repoRoot: string): Promise<ChangedFile[]> {
  const results = await Promise.all(
    files.map(async (file) => {
      if (isTestPath(file.filename)) return null;
      const isGenerated = await isGeneratedPath(repoRoot, file.filename);
      if (isGenerated) return null;
      return file;
    })
  );
  return results.filter(Boolean) as ChangedFile[];
}

export function isTestPath(file: string): boolean {
  const patterns = [
    "**/__tests__/**",
    "**/test/**",
    "**/tests/**",
    "**/*.test.*",
    "**/*.spec.*",
    "**/*_test.*",
    "**/*-test.*",
  ];
  return patterns.some((pattern) => minimatch(file, pattern));
}

export async function isGeneratedPath(repoRoot: string, file: string): Promise<boolean> {
  const cached = generatedCache.get(file);
  if (cached !== undefined) return cached;
  try {
    const { stdout } = await execFileAsync("git", ["check-attr", "linguist-generated", "--", file], {
      cwd: repoRoot,
    });
    const value = stdout.trim().split(":").pop()?.trim();
    const isGenerated = value === "true" || value === "set";
    generatedCache.set(file, isGenerated);
    return isGenerated;
  } catch {
    generatedCache.set(file, false);
    return false;
  }
}

export function countDistinctDirectories(files: string[]): number {
  const dirs = new Set<string>();
  for (const file of files) {
    const dir = path.posix.dirname(file);
    dirs.add(dir === "." ? "(root)" : dir);
  }
  return dirs.size;
}
