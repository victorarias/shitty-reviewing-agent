# Repository Guidelines

## Project Structure & Module Organization
- `src/`: TypeScript source. Core logic in `src/agent.ts`, prompts in `src/prompt.ts`, tool implementations under `src/tools/`.
- `tests/`: Test files (Bun test runner).
- `scripts/`: Utility scripts (e.g., `scripts/smoke.mjs`).
- `dist/`: Build output (ignored by git).
- `.github/workflows/`: CI and release workflows.

## Build, Test, and Development Commands
- `npm run build`: Type-checks and builds with `tsc`.
- `npm test`: Runs tests via `bun test`.
- `npm run smoke`: Runs a local smoke review against a PR (see `scripts/smoke.mjs`).
- `npm start`: Runs the Action entrypoint locally with Bun.

## Coding Style & Naming Conventions
- Language: TypeScript (ESM). Use 2-space indentation.
- File names: lower-kebab or lower-camel (existing pattern in `src/`).
- Types and interfaces in `src/types.ts`; prefer explicit types for tool inputs/outputs.
- Keep prompt strings in `src/prompt.ts` and review summary formatting in `src/summary.ts`.

## Testing Guidelines
- Framework: Bun test (`npm test`).
- Place tests under `tests/` with descriptive names, e.g., `tests/prompt.test.ts`.
- For behavior changes in prompts or tools, add targeted tests where feasible.

## Commit & Pull Request Guidelines
- Commit messages: short, imperative, and scoped (e.g., "Adjust Gemini 3 defaults").
- PRs should include: a concise summary, testing notes, and links to related issues if applicable.
- For user-facing behavior changes, update `README.md` and/or Action inputs in `action.yml`.

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
- Bump `package.json` and `package-lock.json` to the new version.
- Commit the version bump (e.g., "Bump version to v0.2.1").
- Create an annotated or lightweight tag `vX.Y.Z` on that commit.
- Push the commit and tag: `git push origin main` and `git push origin vX.Y.Z`.
