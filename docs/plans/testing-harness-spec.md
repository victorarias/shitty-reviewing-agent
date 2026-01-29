# Testing Harness Specification (Live LLM Snapshots + Offline Confidence)

Status: Draft
Owner: repo maintainers
Last updated: 2026-01-28

## Purpose
The codebase has expanded and live manual testing is painful. This spec defines a testing harness that delivers high confidence by combining:

- Deterministic offline tests (fast, always-on).
- Live LLM snapshot tests (real model calls, every PR).
- Clear, automated verification steps.

The harness targets this repository and its current architecture (Bun tests, fake Octokit, and agent overrides).

## Goals
- High confidence that the agent behaves correctly after feature changes.
- Live model coverage on every PR, with snapshots stored in-repo.
- Isolation from GitHub side effects (no real PR comments in tests).
- Deterministic comparisons with minimal flakiness.
- Automated verification in CI.

## Non-Goals
- Full GitHub Actions end-to-end integration in every test run.
- Running live LLM calls for forked PRs (secrets unavailable).
- Perfect determinism across all model drift (handled by snapshot updates).

## Overview
The harness consists of three layers:

1) Offline deterministic tests (default `npm test`).
2) Live LLM snapshot tests (every PR, internal only).
3) Optional local scenario runner for ad-hoc diffs.

Snapshots are stored under `tests/fixtures/llm/` so changes are reviewable.

## Configuration Changes

### Allow API key with `google-vertex`
Current behavior disallows `api-key` for `google-vertex`. We will allow it.

Changes:
- `src/app/config.ts`: remove the error that rejects `api-key` for `google-vertex`.
- Keep requirement for non-Vertex providers (no change).
- Update `README.md` and `action.yml` to document that:
  - `api-key` is required for non-Vertex.
  - `api-key` is optional but allowed for Vertex.

Rationale:
- CI will provide a `VERTEX_AI_API_KEY` secret.
- This key must be accepted to allow live LLM tests for every PR.

## Snapshot Test Harness

### Summary
Live snapshot tests call the real model and compare normalized outputs to golden files stored in-repo.

### Inputs
Each scenario supplies:
- `ReviewConfig` (provider/model/temperature/reasoning).
- `ChangedFile[]` with patches.
- Optional `existingComments` and `reviewThreads`.
- Expected assertions.

### Output
Snapshot artifacts stored in:
- `tests/fixtures/llm/<scenario>.record.json` (raw run data)
- `tests/fixtures/llm/<scenario>.golden.json` (normalized comparison target)

### Normalization Rules
To reduce flakiness:
- Strip timestamps.
- Sort arrays of comments deterministically (path, line, side).
- Redact secrets (API keys, tokens) if they appear.
- Normalize whitespace in summary/comment bodies.

### Determinism Settings
Default snapshot settings:
- `temperature: 0`
- `reasoning: low` or `off`
- `maxFiles` small enough for predictable tool usage

### Test Assertions
Each scenario must assert at least:
- Summary posted and includes standard sections.
- Footer contains "Reviewed by shitty-reviewing-agent" and bot marker.
- Inline comments and suggestions (if expected) are present and valid for the patch.
- Ignore patterns are respected when applicable.

### Files and Entry Points
Additions:
- `tests/llm-snapshots.test.ts`: runner for live snapshot tests.
- `scripts/record-llm.ts`: regenerates golden snapshots.

Package scripts:
- `npm run test:llm` -> `RUN_LLM_SNAPSHOTS=1 bun test tests/llm-snapshots.test.ts`
- `npm run record:llm` -> `RUN_LLM_SNAPSHOTS=1 bun scripts/record-llm.ts`

## Scenario Fixtures (Repo-Specific)

Each scenario is a JSON fixture under `tests/fixtures/llm/scenarios/`.

Required fields:
- `id`: stable scenario id.
- `description`: short explanation.
- `config`: provider/model/temperature/reasoning/maxFiles.
- `changedFiles`: list of `ChangedFile` objects including `patch`.
- `expected`: assertion config (summary patterns, counts, etc.).

Recommended initial scenarios:

### Scenario A: Summary format + footer
- Files: `src/summary.ts`
- Patch: small change in summary formatting.
- Expected:
  - Summary header `## Review Summary`.
  - Footer contains `Reviewed by shitty-reviewing-agent`.
  - Bot marker present.

### Scenario B: Inline comment + suggestion
- Files: `src/commands/command-runner.ts`
- Patch: small change in tool filtering or prompt logic.
- Expected:
  - At least 1 inline comment.
  - At least 1 `suggestion` block.
  - Comments reference valid lines in the patch.

### Scenario C: Ignore pattern
- Files: `package-lock.json` or `*.generated.*`
- Patch: trivial change.
- Expected:
  - No inline comments.
  - Summary still posted.
  - Ignore patterns applied.

### Scenario D: Compaction path
- Files: `src/agent/context-compaction.ts` and `src/agent/agent-setup.ts`.
- Patch: large enough to trigger compaction.
- Expected:
  - Compaction summary message present.
  - Summary still posted.

### Scenario E: Scheduled write + PR creation
- Mode: schedule
- Command prompt uses repo write tools to update `docs/seed.md` and create `docs/auto.md`.
- Expected:
  - PR creation call captured.
  - Changed files include the docs updates.
  - Require the model to perform repo writes (no fallback); failing to write should fail the snapshot test.

## GitHub Isolation
All snapshot tests use the fake Octokit helper. No GitHub write APIs are called.

Optional local-only helper:
- `scripts/run-local-scenario.mjs`: generate `ChangedFile[]` from `git diff` between refs and run `runReview()` with fake Octokit.
- Not used in CI.

## CI Requirements

### Workflow Rules
- Always run deterministic tests (`npm test`).
- Run live LLM snapshot tests on every PR for internal branches (set `RUN_LLM_SNAPSHOTS=1`).
- Skip live LLM snapshot tests for fork PRs.

Example CI condition:

```
if: github.event.pull_request.head.repo.fork == false
```

### Secrets
- `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) when snapshot scenarios use provider `google`.
- For `google-vertex`, either:
  - `VERTEX_AI_API_KEY` (Vertex Express), or
  - ADC via `GOOGLE_CLOUD_PROJECT`/`GCLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` (no API key).

Note: Fork PRs do not have access to secrets; they will skip live LLM snapshot tests.

## Verification (Automated)

### Local Verification
1) Run deterministic tests:

```
npm test
```

2) Run live LLM snapshot tests (requires `VERTEX_AI_API_KEY` or ADC):

```
export VERTEX_AI_API_KEY=... 
npm run test:llm
```

3) Regenerate snapshots (when expected changes occur):

```
export VERTEX_AI_API_KEY=...
npm run record:llm
```

### CI Verification
Automated checks on every PR:
- `npm test` must pass.
- `npm run test:llm` must pass (internal PRs only).

Success criteria:
- CI passes for deterministic tests.
- Live snapshot tests match goldens without manual edits.

If snapshots diverge:
- `record:llm` updates goldens, and the PR includes those changes with a rationale.

## Implementation Checklist
- [ ] Update `src/app/config.ts` to allow `api-key` for `google-vertex`.
- [ ] Add documentation updates in `README.md` and `action.yml`.
- [ ] Add scenario fixtures under `tests/fixtures/llm/scenarios/`.
- [ ] Add `tests/llm-snapshots.test.ts` and harness utilities.
- [ ] Add `scripts/record-llm.ts`.
- [ ] Add `npm run test:llm` and `npm run record:llm` scripts.
- [ ] Update CI workflow to run live snapshot tests for internal PRs.

## Acceptance Criteria
- Live LLM snapshot tests run on every internal PR.
- Snapshot diffs are reviewable and stored in repo.
- Deterministic tests remain fast and stable.
- No GitHub writes occur during tests.
- Config accepts `api-key` for `google-vertex` without error.
