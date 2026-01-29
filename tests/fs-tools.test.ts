import { test, expect, afterEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { createReadOnlyTools } from "../src/tools/fs.ts";

const tempDir = path.join(process.cwd(), "data");
const tempPath = path.join(tempDir, "tmp-read-test.txt");
const dotDotPath = path.join(process.cwd(), "..foo");

afterEach(async () => {
  try {
    await fs.unlink(tempPath);
  } catch {
    // ignore
  }
  try {
    await fs.unlink(dotDotPath);
  } catch {
    // ignore
  }
});

test("read tool annotates partial reads", async () => {
  await fs.mkdir(tempDir, { recursive: true });
  const content = Array.from({ length: 6 }, (_, i) => `line-${i + 1}`).join("\n");
  await fs.writeFile(tempPath, content, "utf8");
  const tools = createReadOnlyTools(process.cwd());
  const readTool = tools.find((tool) => tool.name === "read");
  if (!readTool) throw new Error("read tool missing");

  const result = await readTool.execute("", {
    path: path.posix.join("data", "tmp-read-test.txt"),
    start_line: 1,
    end_line: 2,
    max_chars: 1000,
  });

  expect(result.content[0].text).toContain("lines 1-2 of 6");
  expect(result.content[0].text).toContain("line-1");
  expect(result.content[0].text).toContain("line-2");
});

test("read tool annotates truncation", async () => {
  await fs.mkdir(tempDir, { recursive: true });
  const content = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join("\n");
  await fs.writeFile(tempPath, content, "utf8");
  const tools = createReadOnlyTools(process.cwd());
  const readTool = tools.find((tool) => tool.name === "read");
  if (!readTool) throw new Error("read tool missing");

  const result = await readTool.execute("", {
    path: path.posix.join("data", "tmp-read-test.txt"),
    start_line: 1,
    end_line: 10,
    max_chars: 10,
  });

  expect(result.content[0].text).toContain("truncated at 10 chars");
  expect(result.content[0].text).toContain("...<truncated>");
});

test("ls tool allows repo root", async () => {
  const tools = createReadOnlyTools(process.cwd());
  const lsTool = tools.find((tool) => tool.name === "ls");
  if (!lsTool) throw new Error("ls tool missing");

  const result = await lsTool.execute("", {});
  expect(result.details.entries.length).toBeGreaterThan(0);
});

test("ls tool supports long metadata", async () => {
  await fs.mkdir(tempDir, { recursive: true });
  await fs.writeFile(tempPath, "metadata\n", "utf8");
  const tools = createReadOnlyTools(process.cwd());
  const lsTool = tools.find((tool) => tool.name === "ls");
  if (!lsTool) throw new Error("ls tool missing");

  const result = await lsTool.execute("", { path: "data", long: true });
  expect(result.details.longEntries?.length).toBeGreaterThan(0);
  const entry = result.details.longEntries?.find((item) => item.name === "tmp-read-test.txt");
  expect(entry).toBeTruthy();
  expect(entry?.permissions.length).toBe(10);
  expect(typeof entry?.size).toBe("number");
  expect(entry?.mtime).toContain("T");
});

test("read tool allows files starting with .. in repo root", async () => {
  await fs.writeFile(dotDotPath, "ok", "utf8");
  const tools = createReadOnlyTools(process.cwd());
  const readTool = tools.find((tool) => tool.name === "read");
  if (!readTool) throw new Error("read tool missing");

  const result = await readTool.execute("", { path: "..foo" });
  expect(result.content[0].text).toContain("ok");
});
