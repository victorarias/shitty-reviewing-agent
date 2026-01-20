import { test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { filterDiagramFiles, isTestPath, isGeneratedPath } from "../src/agent.ts";
import type { ChangedFile } from "../src/types.ts";

const repoRoot = process.cwd();
const attrPath = path.join(repoRoot, ".gitattributes");
let originalAttributes: string | null = null;

const makeFile = (filename: string): ChangedFile => ({
  filename,
  status: "modified",
  additions: 1,
  deletions: 0,
  changes: 1,
});

beforeAll(async () => {
  try {
    originalAttributes = await fs.readFile(attrPath, "utf8");
  } catch {
    originalAttributes = null;
  }
  const fixture = await fs.readFile("tests/fixtures/gitattributes-generated.txt", "utf8");
  await fs.writeFile(attrPath, fixture, "utf8");
});

afterAll(async () => {
  if (originalAttributes === null) {
    await fs.unlink(attrPath).catch(() => undefined);
    return;
  }
  await fs.writeFile(attrPath, originalAttributes, "utf8");
});

test("isTestPath matches common test patterns", () => {
  expect(isTestPath("src/__tests__/foo.ts")).toBe(true);
  expect(isTestPath("src/foo.test.ts")).toBe(true);
  expect(isTestPath("src/foo.spec.ts")).toBe(true);
  expect(isTestPath("src/foo_test.go")).toBe(true);
  expect(isTestPath("src/foo.ts")).toBe(false);
});

test("filterDiagramFiles excludes generated and test files", async () => {
  const files: ChangedFile[] = [
    makeFile("generated/file.ts"),
    makeFile("not-generated/file.ts"),
    makeFile("src/__tests__/foo.test.ts"),
  ];

  const result = await filterDiagramFiles(files, repoRoot);
  const names = result.map((file) => file.filename);

  expect(names).toEqual(["not-generated/file.ts"]);
});

test("isGeneratedPath follows gitattributes", async () => {
  expect(await isGeneratedPath(repoRoot, "generated/file.ts")).toBe(true);
  expect(await isGeneratedPath(repoRoot, "not-generated/file.ts")).toBe(false);
});
