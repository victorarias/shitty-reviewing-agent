import { test, expect } from "bun:test";
import { buildUserPrompt } from "../src/prompt.ts";

function buildDiagramPrompt(params: { prTitle: string; prBody: string; changedFiles: string[] }): string {
  const body = params.prBody?.trim() ? params.prBody.trim() : "(no description)";
  const files = params.changedFiles.length > 0 ? params.changedFiles.map((f) => `- ${f}`).join("\n") : "(none)";
  return `# PR Context\nPR title: ${params.prTitle}\nPR description: ${body}\n\nChanged files:\n${files}\n\n# Task\nGenerate a mermaid sequence diagram (only the code, no fences). Use tools if needed.`;
}

test("diagram prompt snapshot matches fixture", async () => {
  const fixture = await Bun.file("tests/fixtures/harness/diagram-prompt.json").json();
  const prompt = buildDiagramPrompt({
    prTitle: fixture.prInfo.title,
    prBody: fixture.prInfo.body,
    changedFiles: fixture.changedFiles.map((file: any) => file.filename),
  });

  const expected = await Bun.file("tests/fixtures/harness/diagram-prompt.golden.txt").text();
  expect(prompt).toBe(expected);
});

test("user prompt includes diagram when provided", async () => {
  const fixture = await Bun.file("tests/fixtures/harness/diagram-prompt.json").json();
  const prompt = buildUserPrompt({
    prTitle: fixture.prInfo.title,
    prBody: fixture.prInfo.body,
    changedFiles: fixture.changedFiles.map((file: any) => file.filename),
    directoryCount: 4,
    maxFiles: 10,
    ignorePatterns: [],
    existingComments: 0,
    lastReviewedSha: null,
    headSha: fixture.prInfo.headSha,
    scopeWarning: null,
    previousVerdict: null,
    previousReviewUrl: null,
    previousReviewAt: null,
    previousReviewBody: null,
    sequenceDiagram: "sequenceDiagram\nA->>B: ping",
  });

  expect(prompt).toContain("sequenceDiagram");
  expect(prompt).toContain("A->>B: ping");
});
