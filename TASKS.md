# Tasks

## Implementation Plan (Custom Prompts + Commands)

### Modules (new/updated)
- `src/app/reviewerc.ts`: load/parse `.reviewerc`, merge with action inputs, expose validated config.
- `src/commands/registry.ts`: command registry + lookup by id.
- `src/commands/args.ts`: parse `!command` / `@bot command` with quoted args.
- `src/commands/run.ts`: execute a command against a review context (PR or scheduled).
- `src/app/mode.ts`: determine run mode from GitHub event + route to command lists.
- `src/tools/git-history.ts`: `git_log` / `git_diff_range` repo-history tools.
- `src/app/schedule.ts`: scheduled runner (job id → command list) + PR creation flow.
- `src/app/write-scope.ts`: enforce `writeScope` + blocked paths.

### Family Branch: config-core
- [ ] PR: `.reviewerc` loader + merge logic  
  Description: Read YAML, validate against schema, merge precedence (action inputs override), add types in `src/types.ts`.  
  DoD:
  - Config parsing fails fast with a clear error on invalid YAML or schema violations.
  - Unit tests added in `tests/config.test.ts` cover valid config, invalid config, and precedence (action inputs override).
  - README updated to document `.reviewerc` location + merge precedence.
  - Backward-compat: fail fast with clear error if removed keys (e.g., `schedule.output`) are present.
  Depends on: none.
- [ ] PR: Command registry + PR run selection  
  Description: Implement `commands` + `review.run` execution; map command id → prompt; default `comment.type: both`.  
  DoD:
  - Command lookup errors are explicit in logs when a configured command id is missing.
  - Unit tests cover command lookup success + missing id behavior.
  - Design doc updated to state PR default `comment.type: both`.
  Depends on: `.reviewerc` loader PR.

### Family Branch: triggers
- [ ] PR: Comment-triggered commands (`!command` / `@bot command`)  
  Description: Parse comment text with quoted args; ignore unknown commands; reject if not PR context; wire to command runner.  
  DoD:
  - Quoted args are parsed into `command.argv` exactly as documented.
  - Unknown commands are no-ops (no comment posted, no errors).
  - Non-PR comment invocations are rejected with a log message.
  - Unit tests cover quoted args, unknown command, and non-PR rejection.
  - Design doc updated with `!command "quoted args"` example.
  Depends on: command registry PR.
- [ ] PR: Event routing + context detection  
  Description: Select run mode based on GitHub event (`pull_request`, `issue_comment`, `schedule`) and route to correct command list.  
  DoD:
  - Event→mode mapping is deterministic and covered by tests.
  - Action logs the chosen mode and the command list it will run.
  - Design doc updated to describe routing logic.
  Depends on: command registry PR.

### Family Branch: scheduled-run
- [ ] PR: Scheduled command execution by job id  
  Description: Read `schedule.runs[GITHUB_JOB]`; no-op when missing; run commands using `git.history`.  
  DoD:
  - Missing job id mapping results in a no-op with a clear log line.
  - Unit tests cover job id mapping and no-op behavior.
  - Design doc updated with `schedule.runs` job id mapping example.
  Depends on: `.reviewerc` loader PR.
- [ ] PR: Git history tools + writeScope + PR creation  
  Description: Implement `git_log` / `git_diff_range`, enforce `writeScope` + blocked paths, deterministic bot branch, open/update PR.  
  DoD:
  - `git_log` and `git_diff_range` tools implemented with documented params (`sinceHours`, `from`, `to`, optional `paths`).
  - `writeScope` blocks writes outside allowed globs and blocks `.github/workflows/**` and `/.reviewerc`.
  - Bot branch name is deterministic and reused when updating an existing PR.
  - Unit tests cover writeScope enforcement and branch naming.
  - Design doc updated for `git.history` and safety guardrails.
  Depends on: scheduled command execution PR.

### Integration Gates (last PR per family)
- [ ] config-core: manual run with `.reviewerc` on a sample PR; verify logs show merged config + command ids.
- [ ] triggers: manual `!command "quoted args"` on a PR comment; verify correct command executed.
- [ ] scheduled-run: manual workflow dispatch with `GITHUB_JOB` mapped in `schedule.runs`; verify PR created.

## Follow-up Ideas (Learnings from other agents)
- [ ] Add read-before-write guard for repo write tools (track reads in filesystem tools and enforce before write/apply_patch).
- [ ] Add patch-only mode / model-based gating (disable `write` + `edit`, allow `apply_patch`).
- [ ] Centralize tool registry and global gating (single place to enable/disable tool categories).
- [ ] Add post-write diagnostics (e.g., diff summary or lightweight lint) to tool results.

## Testing Harness (Live LLM Snapshots)
- [x] Update config/docs to allow `api-key` for `google-vertex`.
- [x] Add LLM snapshot fixtures + runner (`tests/fixtures/llm/**`, `tests/llm-snapshots.test.ts`).
- [x] Add snapshot recording script (`scripts/record-llm.ts`) + package scripts.
- [x] Update CI to run `test:llm` on internal PRs (skip forks).
- [x] Patch `@mariozechner/pi-ai` for Vertex Express API key support (patch-package).
- [ ] Confirm live auth works: `GEMINI_API_KEY` must be a real Gemini API key (Vertex API keys return 401 "API keys are not supported").
- [ ] Verify: `npm test`, `npm run test:llm` (requires key), `npm run build`.
