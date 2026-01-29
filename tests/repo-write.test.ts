import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { createRepoWriteTools } from "../src/tools/repo-write.ts";

function makeRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sra-write-"));
  execSync("git init", { cwd: repoRoot, stdio: "ignore" });
  return repoRoot;
}

test("repo write tools write and delete files", async () => {
  const repoRoot = makeRepo();
  const tools = createRepoWriteTools(repoRoot, { include: ["docs/**"] });
  const writeTool = tools.find((tool) => tool.name === "write_file") as any;
  const deleteTool = tools.find((tool) => tool.name === "delete_file") as any;

  const writeResult = await writeTool.execute("", { path: "docs/readme.md", content: "hello" });
  expect(fs.readFileSync(path.join(repoRoot, "docs/readme.md"), "utf8")).toBe("hello");
  expect(writeResult.details.status.join("\n")).toContain("docs/readme.md");

  const deleteResult = await deleteTool.execute("", { path: "docs/readme.md" });
  expect(fs.existsSync(path.join(repoRoot, "docs/readme.md"))).toBe(false);
  expect(Array.isArray(deleteResult.details.status)).toBe(true);
});

test("repo write tools enforce scope", async () => {
  const repoRoot = makeRepo();
  const tools = createRepoWriteTools(repoRoot, { include: ["docs/**"] });
  const writeTool = tools.find((tool) => tool.name === "write_file") as any;

  let error: any = null;
  try {
    await writeTool.execute("", { path: "src/index.ts", content: "nope" });
  } catch (err) {
    error = err;
  }
  expect(error).not.toBeNull();
});

test("repo write tools reject absolute paths", async () => {
  const repoRoot = makeRepo();
  const tools = createRepoWriteTools(repoRoot);
  const writeTool = tools.find((tool) => tool.name === "write_file") as any;

  await expect(writeTool.execute("", { path: "/etc/hosts", content: "nope" })).rejects.toThrow("Absolute paths");
  await expect(writeTool.execute("", { path: "~/secret", content: "nope" })).rejects.toThrow("Absolute paths");
});

test("repo write tools apply patch", async () => {
  const repoRoot = makeRepo();
  const filePath = path.join(repoRoot, "docs/readme.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "hello\n", "utf8");

  const tools = createRepoWriteTools(repoRoot, { include: ["docs/**"] });
  const patchTool = tools.find((tool) => tool.name === "apply_patch") as any;
  const patch = [
    "diff --git a/docs/readme.md b/docs/readme.md",
    "index 0000000..1111111 100644",
    "--- a/docs/readme.md",
    "+++ b/docs/readme.md",
    "@@ -1 +1 @@",
    "-hello",
    "+hello world",
    "",
  ].join("\n");

  const patchResult = await patchTool.execute("", { patch });
  expect(fs.readFileSync(filePath, "utf8")).toBe("hello world\n");
  expect(typeof patchResult.details.diffStat).toBe("string");
});

test("repo write tools allow files starting with .. in repo root", async () => {
  const repoRoot = makeRepo();
  const tools = createRepoWriteTools(repoRoot);
  const writeTool = tools.find((tool) => tool.name === "write_file") as any;
  const target = path.join(repoRoot, "..foo");

  await writeTool.execute("", { path: "..foo", content: "ok" });
  expect(fs.readFileSync(target, "utf8")).toBe("ok");
});

test("repo write tools surface git errors in details", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sra-write-nogit-"));
  const tools = createRepoWriteTools(repoRoot);
  const writeTool = tools.find((tool) => tool.name === "write_file") as any;

  const result = await writeTool.execute("", { path: "notes.txt", content: "hello" });
  expect(result.details.status).toEqual([]);
  expect(result.details.diffStat).toBe("");
  expect(result.details.statusError).toMatch(/not a git repository/i);
  expect(result.details.diffStatError).toMatch(/not a git repository/i);
});
