import { test, expect } from "bun:test";
import { postFailureSummary, postFallbackSummary } from "../src/agent/summary.ts";

function makeOctokitCapture() {
  const calls: Array<{ args: any }> = [];
  const octokit = {
    rest: {
      issues: {
        createComment: async (args: any) => {
          calls.push({ args });
          return { data: { id: 1 } };
        },
      },
    },
  };
  return { octokit, calls };
}

test("postFailureSummary matches golden output", async () => {
  const { octokit, calls } = makeOctokitCapture();
  await postFailureSummary({
    octokit: octokit as any,
    owner: "owner",
    repo: "repo",
    prNumber: 1,
    reason: "LLM request failed after retries.",
    model: "model-x",
    billing: { input: 10, output: 20, total: 30, cost: 0.123456 },
    reviewSha: "deadbeef",
  });

  expect(calls.length).toBe(1);
  const expected = await Bun.file("tests/fixtures/harness/post-failure.golden.md").text();
  expect(calls[0].args.body).toBe(expected);
});

test("postFallbackSummary matches golden output", async () => {
  const { octokit, calls } = makeOctokitCapture();
  await postFallbackSummary({
    octokit: octokit as any,
    owner: "owner",
    repo: "repo",
    prNumber: 2,
    model: "model-y",
    verdict: "Skipped",
    reason: "Agent exceeded iteration limit before posting summary.",
    billing: { input: 1, output: 2, total: 3, cost: 0.000001 },
    reviewSha: "cafebabe",
  });

  expect(calls.length).toBe(1);
  const expected = await Bun.file("tests/fixtures/harness/post-fallback.golden.md").text();
  expect(calls[0].args.body).toBe(expected);
});
