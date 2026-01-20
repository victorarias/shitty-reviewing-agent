import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { buildThreadsFromReviewComments } from "../src/review-threads.ts";
import type { ExistingComment, ReviewThreadInfo } from "../src/types.ts";

async function loadFixture<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

test("buildThreadsFromReviewComments groups replies into threads", async () => {
  const comments = await loadFixture<ExistingComment[]>("tests/fixtures/review-comments.json");
  const expected = await loadFixture<ReviewThreadInfo[]>("tests/fixtures/review-threads.golden.json");
  const result = buildThreadsFromReviewComments(comments);
  expect(result).toEqual(expected);
});
