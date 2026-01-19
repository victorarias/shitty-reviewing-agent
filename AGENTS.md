# Agent Principles

This project experiments with a "tools-first" review philosophy for frontier models.

Guiding idea:
- Give the model richer context and more precise tools, then let it decide how to behave.
- Prefer explicit choices over hard-coded heuristics. If ambiguity exists, expose it and require the model to choose (e.g., pick a review thread, choose LEFT/RIGHT side, or request a new thread).
- Use model reasoning to avoid repetition and focus on new or unresolved issues rather than suppressing output with brittle dedupe rules.

Notes:
- This is experimental and may change. The current approach may not be optimal; it is an intentional exploration of model-led behavior.
- When adding new functionality, prefer adding tools + instructions over fixed rules, unless the rule is required for safety or correctness.

# Repo Analysis (2026-01-19)

Purpose:
- GitHub Action that runs a tool-using PR review agent over a target PR and posts a structured review summary/comments.

Runtime & entrypoints:
- Action runs in Docker using `Dockerfile` with `bun` and executes `src/index.ts`.
- Core review loop is in `src/agent.ts` (config, tool wiring, stream, retries, failure handling).

Prompting & review behavior:
- System/user prompts assembled in `src/prompt.ts`.
- Summary formatting and verdict reporting in `src/summary.ts`.
- Review tools for posting comments/summaries live in `src/tools/review.ts`.

Integrations & tools:
- GitHub API helpers in `src/tools/github.ts` (PR info, diffs, threads, review context).
- Read-only repo file tools in `src/tools/fs.ts`.
- Optional Gemini web search tool in `src/tools/web-search.ts` (Google-only).

Build/test/release:
- Build: `npm run build` (tsc).
- Tests: `npm test` (bun test).
- Release: push a tag like `v0.1.x` to trigger `.github/workflows/release.yml` and publish to GHCR.
