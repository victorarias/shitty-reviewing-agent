import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import YAML from "yaml";
import type { ReviewercConfig } from "../types.js";

const REVIEWERC_FILENAME = ".reviewerc";
const REMOVED_KEYS: Array<{ path: string[]; message: string }> = [
  {
    path: ["schedule", "output"],
    message: "Removed key schedule.output found. Use schedule.pr instead.",
  },
];

let cachedValidator: ((data: unknown) => boolean) | null = null;
let cachedSchemaErrors: ((data: unknown) => string[]) | null = null;

function getSchemaPath(): string {
  const current = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(current, "../../docs/reviewerc.schema.json");
}

function loadSchema(): unknown {
  const schemaPath = getSchemaPath();
  const raw = fs.readFileSync(schemaPath, "utf8");
  return JSON.parse(raw);
}

function ensureValidator(): void {
  if (cachedValidator) return;
  const schema = loadSchema();
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  cachedValidator = (data: unknown) => validate(data);
  cachedSchemaErrors = (_data: unknown) =>
    (validate.errors ?? []).map((err) => {
      const location = err.instancePath || "(root)";
      return `${location}: ${err.message}`;
    });
}

function hasPath(obj: unknown, pathParts: string[]): boolean {
  let cursor: any = obj;
  for (const part of pathParts) {
    if (!cursor || typeof cursor !== "object" || !(part in cursor)) {
      return false;
    }
    cursor = cursor[part];
  }
  return true;
}

function assertNoRemovedKeys(config: unknown): void {
  for (const entry of REMOVED_KEYS) {
    if (hasPath(config, entry.path)) {
      throw new Error(entry.message);
    }
  }
}

export function readReviewerc(repoRoot: string): ReviewercConfig | null {
  const filePath = path.join(repoRoot, REVIEWERC_FILENAME);
  if (!fs.existsSync(filePath)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error: any) {
    throw new Error(`Failed to read ${REVIEWERC_FILENAME}: ${error?.message ?? String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error: any) {
    throw new Error(`Invalid YAML in ${REVIEWERC_FILENAME}: ${error?.message ?? String(error)}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${REVIEWERC_FILENAME} must contain a YAML object.`);
  }

  assertNoRemovedKeys(parsed);
  ensureValidator();
  if (!cachedValidator?.(parsed)) {
    const errors = cachedSchemaErrors?.(parsed) ?? ["(unknown schema error)"];
    throw new Error(`Invalid ${REVIEWERC_FILENAME}: ${errors.join("; ")}`);
  }

  return parsed as ReviewercConfig;
}
