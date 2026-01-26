import { minimatch } from "minimatch";
import type { ChangedFile } from "../types.js";

export function applyIgnorePatterns(files: ChangedFile[], patterns: string[]): ChangedFile[] {
  if (patterns.length === 0) return files;
  return files.filter((file) => !patterns.some((pattern) => minimatch(file.filename, pattern)));
}
