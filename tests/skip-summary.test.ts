import { test, expect } from "bun:test";
import { postNoNewChangesSummary, postSkipSummary } from "../src/app/summary.ts";

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

test("postSkipSummary matches golden output", async () => {
  const { octokit, calls } = makeOctokitCapture();
  await postSkipSummary(octokit as any, { owner: "owner", repo: "repo", prNumber: 1 }, "model-skip", 7, 5);

  expect(calls.length).toBe(1);
  const expected = await Bun.file("tests/fixtures/harness/skip-summary.golden.md").text();
  expect(calls[0].args.body).toBe(expected);
});

test("postNoNewChangesSummary includes marker and reason", async () => {
  const { octokit, calls } = makeOctokitCapture();
  await postNoNewChangesSummary(
    octokit as any,
    { owner: "owner", repo: "repo", prNumber: 1 },
    "model-skip",
    "deadbeef",
    "Push appears to be rebase/merge-only."
  );

  expect(calls.length).toBe(1);
  expect(calls[0].args.body).toContain("**Verdict:** Skipped");
  expect(calls[0].args.body).toContain("rebase/merge-only");
  expect(calls[0].args.body).toContain("sri:last-reviewed-sha:deadbeef");
});
