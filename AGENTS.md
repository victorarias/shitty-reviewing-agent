# Repository Guidelines

## Project Structure & Module Organization
- `src/`: TypeScript source. Core logic in `src/agent.ts`, review prompts in `src/prompts/review.ts`, tool implementations under `src/tools/`.
- `tests/`: Test files (Bun test runner).
- `scripts/`: Utility scripts (e.g., `scripts/smoke.mjs`).
- `dist/`: Build output (ignored by git).
- `.github/workflows/`: CI and release workflows.

## Build, Test, and Development Commands
- `bun run build`: Type-checks and builds with `tsc`.
- `bun test`: Runs tests via Bun test runner.
- `bun run smoke`: Runs a local smoke review against a PR (see `scripts/smoke.mjs`).
- `bun run start`: Runs the Action entrypoint locally with Bun.

## Coding Style & Naming Conventions
- Language: TypeScript (ESM). Use 2-space indentation.
- File names: lower-kebab or lower-camel (existing pattern in `src/`).
- Types and interfaces in `src/types.ts`; prefer explicit types for tool inputs/outputs.
- Keep review prompt strings in `src/prompts/review.ts` and review summary formatting in `src/summary.ts`. Command prompts live in `src/commands/command-runner.ts`.

## Testing Guidelines
- Framework: Bun test (`bun test`).
- Place tests under `tests/` with descriptive names, e.g., `tests/prompt.test.ts`.
- For behavior changes in prompts or tools, add targeted tests where feasible.

## Commit & Pull Request Guidelines
- Commit messages: short, imperative, and scoped (e.g., "Adjust Gemini 3 defaults").
- PRs should include: a concise summary, testing notes, and links to related issues if applicable.
- For user-facing behavior changes, update `README.md` and/or Action inputs in `action.yml`.
- For tool changes, update the tool inventory in `README.md` and document the tool schema for the LLM in `src/prompts/review.ts` and `src/commands/command-runner.ts`, plus add targeted tests when feasible.

## Documentation Taxonomy
- `docs/designs/`: Persistent designs that describe how the system should work long-term. Keep these updated as behavior evolves.
- `docs/plans/`: Implementation plans for a specific change or milestone.
- `docs/archived/`: Completed or invalidated designs/plans kept for reference.

## Agent Principles
- This project experiments with a tools-first review philosophy for frontier models.
- Prefer explicit choices over hard-coded heuristics; expose ambiguity and let the model choose.
- Use model reasoning to avoid repeating resolved feedback; focus on new or unresolved issues.
- When adding new functionality, prefer adding tools + instructions over fixed rules, unless required for safety or correctness.


## Security & Configuration Tips
- API keys are provided via Action inputs (`api-key`) or ADC for Vertex; never commit secrets.
- Release is tag-driven: push a tag like `v0.1.5` to trigger `.github/workflows/release.yml`.

## Release Checklist
- Decide the next version (use semver; patch for fixes, minor for new features, major for breaking changes).
- Bump `package.json` to the new version.
- Commit the version bump (e.g., "Bump version to v0.2.1").
- Create an annotated or lightweight tag `vX.Y.Z` on that commit.
- Push the commit and tag: `git push origin main` and `git push origin vX.Y.Z`.
- Create the GitHub release with a changelog (e.g., `gh release create vX.Y.Z --generate-notes`).
