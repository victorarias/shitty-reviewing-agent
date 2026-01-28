import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRepoWriteTools } from "../src/tools/repo-write.ts";

function makeRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sra-write-"));
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
  return repoRoot;
}

test("repo write tools write and delete files", async () => {
  const repoRoot = makeRepo();
  const tools = createRepoWriteTools(repoRoot, { include: ["docs/**"] });
  const writeTool = tools.find((tool) => tool.name === "write_file") as any;
  const deleteTool = tools.find((tool) => tool.name === "delete_file") as any;

  await writeTool.execute("", { path: "docs/readme.md", content: "hello" });
  expect(fs.readFileSync(path.join(repoRoot, "docs/readme.md"), "utf8")).toBe("hello");

  await deleteTool.execute("", { path: "docs/readme.md" });
  expect(fs.existsSync(path.join(repoRoot, "docs/readme.md"))).toBe(false);
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

  await patchTool.execute("", { patch });
  expect(fs.readFileSync(filePath, "utf8")).toBe("hello world\n");
});
