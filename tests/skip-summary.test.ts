import { test, expect } from "bun:test";
import { postSkipSummary } from "../src/app/summary.ts";

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
