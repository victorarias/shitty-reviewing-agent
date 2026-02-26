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

## Release

Push a tag like `v0.1.0` to trigger `.github/workflows/release.yml` which builds and publishes to GHCR.
