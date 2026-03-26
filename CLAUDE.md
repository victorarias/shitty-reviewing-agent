# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A GitHub Action that reviews PRs using an LLM-powered agent. The agent reads full files (not just diffs), uses tools to explore code, and posts inline comments/suggestions with a final review summary. Supports incremental reviews that track changes since the last review.

**Philosophy:** Tools-first approach—give the model rich context and precise tools, then let it decide how to behave. Prefer explicit choices over hard-coded heuristics. See `AGENTS.md` for design principles.

## Commands

```bash
bun test                # Run tests
bun test tests/foo.test.ts  # Run single test file
bun src/index.ts        # Run the agent directly
bun run build           # Compile TypeScript to dist/
```

**Local smoke test:**
```bash
bun scripts/smoke.mjs \
  --provider openrouter \
  --api-key "$OPENROUTER_KEY" \
  --model anthropic/claude-sonnet-4 \
  --repo owner/name \
  --pr 123 \
  --token "$GITHUB_TOKEN"
```

## Architecture

```
src/
├── index.ts      # Entry: reads config, fetches PR data, orchestrates review
├── agent.ts      # Agent loop: tool setup, iteration control, error handling
├── prompt.ts     # System and user prompt builders
├── summary.ts    # Review summary markdown generation
├── github-api.ts # GitHub API helpers (review threads)
├── types.ts      # TypeScript interfaces
└── tools/
    ├── fs.ts         # Read-only filesystem (read, search) from pi-mono
    ├── github.ts     # PR info, diffs, changed files, review context
    ├── review.ts     # comment, suggest, post_summary, list_threads_for_location
    └── web-search.ts # Gemini web search tool
```

**Flow:** `index.ts` → fetch PR data + resolve auth → `agent.ts` → build prompts → agent loop with tools → post summary

**Key dependencies:**
- `@mariozechner/pi-agent-core` - Agent framework and filesystem tools
- `@mariozechner/pi-ai` - Unified LLM interface (OpenRouter, Gemini, Anthropic, OpenAI, Vertex)
- `@actions/github` - GitHub API via Octokit

## Key Concepts

**Incremental reviews:** Stores last reviewed SHA in a comment marker (`<!-- sri:last-reviewed-sha:XXX -->`). Follow-up reviews compare against this to review only new changes.

**Thread handling:** The agent checks existing review threads before commenting. When multiple threads exist at the same location, it must explicitly choose which to reply to or create a new thread.

**Prompts:** System prompt defines review behavior and tool usage. User prompt includes PR context, file list, and prior review info for follow-ups.

## Testing

Tests use Bun's built-in test runner. Test files are in `tests/`:
- `review-tools.test.ts` - Comment tool behavior, thread replies, ambiguity handling
- `list-threads.test.ts` - Thread listing and filtering
- `summary.test.ts` - Summary markdown rendering

## Debugging Agent Behavior

When the reviewing agent produces unexpected output (duplicated comments, wrong placements, confused findings, etc.), **do not assume it's a model quality issue.** Frontier models follow instructions correctly when the instructions and tool contracts are clear. The root cause is almost always in the harness — the tools, prompts, or validation logic.

Investigation checklist:
1. **Trace the tool call sequence from CI logs.** Reconstruct exactly what the model sent, what each tool returned, and what the model saw before its next decision.
2. **Check what the harness silently modifies.** Functions like `ensureFindingContextLabel` transform the model's output before posting. The model never sees these transformations. If the harness injects content that overlaps with what the model wrote, the visible output looks duplicated even though the model only said it once.
3. **Check what the tool responses communicate back.** If a tool returns "Comment posted: 123" but doesn't say *where* or *what was modified*, the model has limited ability to track state across batches. Sparse tool responses can cause the model to retry or duplicate work.
4. **Check what the validation rules pressure the model to do.** Strict traceability rules (e.g., "every inline finding must have a linked comment or post_summary will fail") can nudge the model into creating redundant findings to satisfy constraints, especially when an earlier assignment was imperfect.
5. **Check within-session state tracking.** Dedup indexes built from pre-existing data at construction time won't catch duplicates created during the current session. If the model posts two comments at the same location in different batches, the second one may bypass all dedup checks.

The default hypothesis should be: "the harness made it easy for the model to do the wrong thing" — not "the model is bad at this."

## Release

Push a tag like `v0.1.0` to trigger `.github/workflows/release.yml` which builds and publishes to GHCR.
