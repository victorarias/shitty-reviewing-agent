import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { createGitHistoryTools } from "../src/tools/git-history.ts";

function initRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sra-git-"));
  execSync("git init", { cwd: repoRoot });
  execSync("git config user.name \"Test\"", { cwd: repoRoot });
  execSync("git config user.email \"test@example.com\"", { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, "file.txt"), "one\n", "utf8");
  execSync("git add .", { cwd: repoRoot });
  execSync("git commit -m \"first\"", { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, "file.txt"), "two\n", "utf8");
  execSync("git add .", { cwd: repoRoot });
  execSync("git commit -m \"second\"", { cwd: repoRoot });
  return repoRoot;
}

test("git history tools return commits and diffs", async () => {
  const repoRoot = initRepo();
  const tools = createGitHistoryTools(repoRoot);
  const logTool = tools.find((tool) => tool.name === "git_log") as any;
  const diffTool = tools.find((tool) => tool.name === "git_diff_range") as any;
  const gitTool = tools.find((tool) => tool.name === "git") as any;

  const logResult = await logTool.execute("", { sinceHours: 24 });
  expect(logResult.details.commits.length).toBeGreaterThan(0);

  const diffResult = await diffTool.execute("", { from: "HEAD~1", to: "HEAD" });
  expect(diffResult.details.diff).toContain("+two");

  const showResult = await gitTool.execute("", { args: ["show", "--name-only", "-n", "1", "HEAD"] });
  expect(showResult.details.stdout).toContain("file.txt");
});
