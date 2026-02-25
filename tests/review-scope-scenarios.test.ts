import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fetchChangesSinceReview } from "../src/app/pr-data.ts";
import type { ChangedFile, ReviewContext } from "../src/types.ts";

type ScenarioStep =
  | {
    op: "commit";
    branch: "main" | "feature";
    message: string;
    changes: Array<
      | { action: "write"; path: string; content: string }
      | { action: "rename"; from: string; to: string }
      | { action: "delete"; path: string }
    >;
  }
  | { op: "mark_last_reviewed" }
  | { op: "rebase_feature_onto_main" }
  | { op: "merge_main_into_feature"; message: string };

interface ScenarioFixture {
  id: string;
  description: string;
  steps: ScenarioStep[];
  expected: {
    decision: "review" | "skip_confident";
    reasonCode: string;
    files: string[];
  };
}

const context: ReviewContext = {
  owner: "owner",
  repo: "repo",
  prNumber: 1,
};

const fixturesDir = resolve("tests/fixtures/review-scope-scenarios");
const fixtureFiles = readdirSync(fixturesDir)
  .filter((name) => name.endsWith(".json"))
  .sort();

for (const fileName of fixtureFiles) {
  const fixture = JSON.parse(readFileSync(join(fixturesDir, fileName), "utf8")) as ScenarioFixture;
  test(`review scope scenario: ${fixture.id}`, async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "sra-scope-"));
    const repoRoot = join(tempRoot, "repo");
    try {
      setupScenarioRepo(repoRoot);
      const refs = await executeScenario(repoRoot, fixture);
      const fallbackFiles = listChangedFiles(repoRoot, `${refs.mainBranch}...${refs.featureBranch}`);
      const compareData = buildCompareData(repoRoot, refs.lastReviewedSha, refs.headSha);

      const octokit = {
        rest: {
          repos: {
            compareCommits: async () => ({ data: compareData }),
          },
        },
      };

      const result = await fetchChangesSinceReview(
        octokit as any,
        context,
        refs.lastReviewedSha,
        refs.headSha,
        fallbackFiles,
        { repoRoot }
      );

      const resultPaths = result.files.map((file) => file.filename).sort();
      const expectedPaths = [...fixture.expected.files].sort();

      expect(result.decision).toBe(fixture.expected.decision);
      expect(result.reasonCode).toBe(fixture.expected.reasonCode);
      expect(resultPaths).toEqual(expectedPaths);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
}

function setupScenarioRepo(repoRoot: string): void {
  git(process.cwd(), ["clone", "--quiet", "--shared", process.cwd(), repoRoot]);
  git(repoRoot, ["config", "user.name", "Scope Harness"]);
  git(repoRoot, ["config", "user.email", "scope-harness@example.com"]);
  git(repoRoot, ["checkout", "-q", "-b", "scope-main"]);

  const sharedPath = join(repoRoot, ".scope-harness/shared.txt");
  mkdirSync(dirname(sharedPath), { recursive: true });
  writeFileSync(sharedPath, "seed\nline-1\nline-2\nline-3\nline-4\nline-5\n", "utf8");
  git(repoRoot, ["add", ".scope-harness/shared.txt"]);
  git(repoRoot, ["commit", "-q", "-m", "scope: seed shared file", "--no-gpg-sign"]);

  git(repoRoot, ["checkout", "-q", "-b", "scope-feature"]);
}

async function executeScenario(
  repoRoot: string,
  fixture: ScenarioFixture
): Promise<{ mainBranch: string; featureBranch: string; lastReviewedSha: string; headSha: string }> {
  const mainBranch = "scope-main";
  const featureBranch = "scope-feature";
  let lastReviewedSha: string | null = null;

  for (const step of fixture.steps) {
    if (step.op === "commit") {
      const branch = step.branch === "main" ? mainBranch : featureBranch;
      git(repoRoot, ["checkout", "-q", branch]);
      applyChanges(repoRoot, step.changes);
      git(repoRoot, ["add", "-A", ".scope-harness"]);
      git(repoRoot, ["commit", "-q", "-m", step.message, "--no-gpg-sign"]);
      continue;
    }

    if (step.op === "mark_last_reviewed") {
      git(repoRoot, ["checkout", "-q", featureBranch]);
      lastReviewedSha = git(repoRoot, ["rev-parse", "HEAD"]).trim();
      continue;
    }

    if (step.op === "rebase_feature_onto_main") {
      git(repoRoot, ["checkout", "-q", featureBranch]);
      git(repoRoot, ["rebase", mainBranch]);
      continue;
    }

    if (step.op === "merge_main_into_feature") {
      git(repoRoot, ["checkout", "-q", featureBranch]);
      git(repoRoot, ["merge", "--no-ff", "-m", step.message, mainBranch]);
      continue;
    }
  }

  if (!lastReviewedSha) {
    throw new Error(`Scenario ${fixture.id} did not set last reviewed SHA.`);
  }
  const headSha = git(repoRoot, ["rev-parse", featureBranch]).trim();
  return { mainBranch, featureBranch, lastReviewedSha, headSha };
}

function applyChanges(
  repoRoot: string,
  changes: Array<
    | { action: "write"; path: string; content: string }
    | { action: "rename"; from: string; to: string }
    | { action: "delete"; path: string }
  >
): void {
  for (const change of changes) {
    if (change.action === "write") {
      const absolute = join(repoRoot, change.path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, change.content, "utf8");
      continue;
    }
    if (change.action === "rename") {
      const fromAbsolute = join(repoRoot, change.from);
      const toAbsolute = join(repoRoot, change.to);
      mkdirSync(dirname(toAbsolute), { recursive: true });
      renameSync(fromAbsolute, toAbsolute);
      continue;
    }
    const absolute = join(repoRoot, change.path);
    unlinkSync(absolute);
  }
}

function buildCompareData(
  repoRoot: string,
  baseSha: string,
  headSha: string
): {
  status: "identical" | "ahead" | "behind" | "diverged";
  ahead_by: number;
  behind_by: number;
  files: Array<{
    filename: string;
    previous_filename?: string;
    status: ChangedFile["status"];
    additions: number;
    deletions: number;
    changes: number;
  }>;
} {
  const countsOutput = git(repoRoot, ["rev-list", "--left-right", "--count", `${baseSha}...${headSha}`]).trim();
  const [leftRaw, rightRaw] = countsOutput.split(/\s+/);
  const behindBy = Number.parseInt(leftRaw, 10) || 0;
  const aheadBy = Number.parseInt(rightRaw, 10) || 0;
  const status =
    behindBy === 0 && aheadBy === 0
      ? "identical"
      : behindBy === 0
        ? "ahead"
        : aheadBy === 0
          ? "behind"
          : "diverged";
  const files = listChangedFiles(repoRoot, `${baseSha}...${headSha}`).map((file) => ({
    filename: file.filename,
    previous_filename: file.previous_filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
  }));
  return {
    status,
    ahead_by: aheadBy,
    behind_by: behindBy,
    files,
  };
}

function listChangedFiles(repoRoot: string, rangeSpec: string): ChangedFile[] {
  const output = git(repoRoot, ["diff", "--name-status", rangeSpec]).trim();
  if (!output) return [];
  return output
    .split(/\r?\n/)
    .map((line) => parseNameStatusLine(line))
    .filter((file): file is ChangedFile => Boolean(file));
}

function parseNameStatusLine(line: string): ChangedFile | null {
  const parts = line.split("\t");
  if (parts.length < 2) return null;
  const code = parts[0];
  const kind = code[0] ?? "";
  if (kind === "R" || kind === "C") {
    if (parts.length < 3) return null;
    const previous = parts[1];
    const current = parts[2];
    return {
      filename: current,
      previous_filename: previous,
      status: kind === "R" ? "renamed" : "copied",
      additions: 0,
      deletions: 0,
      changes: 0,
    };
  }

  const filename = parts[1];
  return {
    filename,
    status: mapStatus(kind),
    additions: 0,
    deletions: 0,
    changes: 0,
  };
}

function mapStatus(kind: string): ChangedFile["status"] {
  if (kind === "A") return "added";
  if (kind === "M") return "modified";
  if (kind === "D") return "removed";
  if (kind === "R") return "renamed";
  if (kind === "C") return "copied";
  return "changed";
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).toString();
}
