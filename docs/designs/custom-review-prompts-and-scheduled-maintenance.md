# Custom Review Prompts + Scheduled Maintenance (Design)

## Status

- Stage: design (persistent)
- Scope: `.reviewerc` configuration + runtime behavior for custom prompts and scheduled maintenance runs.

## Goals

- Let teams define custom prompts that run as subagents during PR review.
- Support output modes: feed into the main review, separate comments, or both.
- Enable scheduled prompts that can create PRs (maintenance, docs drift, policy checks).
- Keep repo-owned config in `.reviewerc` and allow `action.yml` inputs to override it.
- Control tool access via allowlisted categories.
- Use the Action’s implicit `GITHUB_TOKEN` (bot) with documented permissions.

## Non-goals

- Replace linters/tests/security scanners.
- Auto-merge PRs.
- Run tests for scheduled prompts (explicitly out of scope).

## `.reviewerc` basics

- Location: repo root (`/.reviewerc`)
- Format: YAML
- Merge precedence: `action.yml` inputs > `.reviewerc` values > built-in defaults
  - Rationale: runtime inputs should override repo config (like env vars).
- Schema: `docs/reviewerc.schema.json` (authoritative structure + allowed values, strict `additionalProperties: false`)

## Comment-triggered commands (App or Action)

In addition to PR-time and scheduled runs, commands can be triggered on demand from PR comments:

- **App mode**: `@app-name command [args...]`
- **Action mode**: `!command [args...]`

Commands are predefined in `.reviewerc` and referenced by `id`. Only known commands are allowed.
These commands always run in PR context. If invoked outside a PR, the action ignores the request.
Unknown commands are ignored (silent no-op).
Action mode requires a workflow listening on `issue_comment` events. App mode requires the GitHub App
to receive issue comment events and run the action.

Commands are the canonical prompt definitions. Both PR review prompts and scheduled jobs can reference
commands instead of redefining the prompt content.

## Workflow-provided context (extra checkouts)

This design intentionally keeps `.reviewerc` focused on prompt behavior, not workflow orchestration.
Teams can extend context in the workflow itself:

- **Extra repos**: Clone additional repositories before running the action (e.g., `company-rules/`).
  Prompts can read those files by path (e.g., `company-rules/docs/api-rules.md`).
  Example prompt line: \"Apply the rules in company-rules/docs/api-rules.md to the changes in this repo.\"

Example workflow snippet:
```yaml
jobs:
  nightly-rules:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/checkout@v4
        with:
          repository: your-org/company-rules
          path: company-rules
      - uses: ghcr.io/yourname/shitty-reviewing-agent:latest
        with:
          provider: openrouter
          api-key: ${{ secrets.OPENROUTER_KEY }}
          model: anthropic/claude-sonnet-4
```

This keeps repo-specific setup flexible without pushing workflow logic into the core action.

## Tool allowlist (category-based)

Allowlist applies to all prompts; prompts can further restrict but cannot expand it.

Supported categories (proposed):
- `filesystem` (read-only): `read`, `grep`, `find`, `ls`
  - Why: core repo context without mutation.
- `git.read`: `get_diff`, `get_changed_files`
  - Why: access to PR diffs and changed files.
- `git.history`: `git_log`, `git_diff_range`
  - Why: scheduled jobs need repo-level history without a PR context.
- `github.read`: `get_pr_info`, list comments/threads
  - Why: PR metadata and context.
- `github.write`: `comment`, `suggest`, `post_summary`
  - Why: PR feedback output.
- `repo.write`: write local files, create branches/commits (scheduled PRs only)
  - Why: enables maintenance PR creation.

Safety guardrails for `repo.write`:
- Never push directly to the base branch; always create/update a bot branch and open a PR.
- Branch creation/push are handled by a dedicated tool with a fixed strategy; branch name is not configurable.
- Optional write scope (include/exclude globs) limits which paths can be modified.
- Always block edits to `.github/workflows/**` and `/.reviewerc`.

## Output modes and comment types

Output modes:
- `feed_main`: condensed summary is merged into the main reviewer output.
- `separate_comment`: standalone PR comment (no main summary integration).
- `both`: do both.

Comment types:
- `issue` comment: top-level PR timeline comment. Best for long, multi-file or repo-wide reports.
- `review` comment: inline comment tied to a file/line. Best for pinpointed findings and suggestions.

Default: use `issue` comments unless the prompt explicitly targets lines. `review` comments only apply to PRs.

Scheduled runs do not have PR context. PR-only tools (e.g., `get_pr_info`, `get_changed_files`, `get_diff`, review comments)
are unavailable in scheduled jobs and should not be expected to work there.

`git.history` tool sketch (scheduled jobs):
- `git_log`: list commits in a time window (e.g., `sinceHours`, optional `paths`).
- `git_diff_range`: diff between two refs (e.g., `from`, `to`, optional `paths`).

## Shared prompt module model

Commands define reusable prompt modules. Review prompts and scheduled jobs reference them.
Review prompts and scheduled jobs can override defaults as needed.

Command definition fields:
- `id` (required): command name used in `@app-name command` or `!command`.
- `title`: human-readable label for comments.
- `prompt` (required): task description for the subagent.
- `tools.allow`: subset of allowlist categories.
- `limits`: guardrails to bound cost/noise.
- `output`: formatting preferences (`format`, `severityFloor`).
- `comment.type` (optional): default comment type for command-triggered runs (defaults to `issue`).
- `files` (optional): default file filters for command-triggered runs.
- `args` (runtime): raw argument string and argv list are passed to the prompt as variables:
  - `${command.args}`: raw trailing text after the command
  - `${command.argv}`: list of tokens split on whitespace, with quotes preserved as a single token
  - Example: `!docs-drift "last 48 hours" --scope docs/` → `argv = ["last 48 hours", "--scope", "docs/"]`

PR review prompts and scheduled jobs reference a command via `commandRef` and can override
`tools`, `limits`, `output`, `files`, and `comment.type` when needed.
`commandRef` and inline `prompt` are mutually exclusive.

All prompts (PR review or scheduled) follow the same module model with overrides:

- `id` (required): stable identifier for tracking/caching.
- `title`: human-readable label for comments.
- `prompt` (required): task description for the subagent.
- `tools.allow`: subset of allowlist categories.
- `limits`: guardrails to bound cost/noise.

Common output contract from subagents:
- `summary`: short overview
- `findings[]`: `{ title, severity, location?, details, suggestion? }`
- `notes[]`: non-blocking observations
- `confidence`: `low` | `medium` | `high`

## Plan A: PR-time custom review prompts

Execution flow:
1) Main reviewer gathers PR context.
2) For each `review.prompts[]`, evaluate conditions and spawn subagent.
3) Route output by `mode`.

Config shape:
```yaml
version: 1
commands:
  - id: security
    title: "Security scan"
    prompt: |
      Review for authz bypass, unsafe deserialization, secrets, and input validation gaps.
    tools:
      allow: [filesystem, git.read, github.read]
    limits:
      maxFiles: 200
      maxFindings: 15
    output:
      format: findings
      severityFloor: medium
    comment:
      type: issue

review:
  defaults:
    provider: openrouter
    model: anthropic/claude-sonnet-4
    reasoning: medium
    temperature: 0.4
  prompts:
    - id: security
      commandRef: security
      mode: separate_comment
      comment:
        type: issue
      files:
        include: ["**/*.ts", "**/*.go"]
        exclude: ["**/*.test.*"]
      # Omitting conditions runs on every PR. Add conditions to filter when needed.

    - id: security-labeled
      commandRef: security
      mode: separate_comment
      comment:
        type: issue
      files:
        include: ["**/*.ts", "**/*.go"]
        exclude: ["**/*.test.*"]
      conditions:
        labels:
          include: ["security"]
```

Key attributes and rationale:
- `commandRef` (recommended): reference to a command defined under `commands`.
- `prompt` (inline): only for one-off prompts; use `commandRef` to reuse logic across triggers.
- `mode`: `feed_main` | `separate_comment` | `both`
  - Controls output routing.
- `comment.type`: `issue` | `review`
  - Controls where the output lands on the PR.
- `files.include` / `files.exclude`: glob filters for scope.
- `tools.allow`: limit tool usage per prompt for safety/cost.
- `limits.maxFiles`: avoid expensive repo-wide scans.
- `limits.maxFindings`: avoid noisy output.
- `output.format`: `findings` | `narrative` | `checklist`
  - Standardizes presentation.
- `output.severityFloor`: `low` | `medium` | `high`
  - Filters trivial findings.
- `conditions`:
  - `draft` (bool)
  - `labels.include` / `labels.exclude`
  - `authors.include` / `authors.exclude`
  - `paths.changed` (bool or list)

Notes:
- If `conditions` are omitted, the prompt runs on every PR.

Permissions (PR review):
- `contents: read`
- `pull-requests: write`

## Plan B: Scheduled maintenance prompts (PR creation)

Recommendation: Use a separate scheduled workflow (e.g., `.github/workflows/reviewer-scheduled.yml`)
that runs on cron and uses the same container. This avoids heavy scans in PR-triggered workflows.
All schedule jobs run each scheduled invocation; use `schedule.jobs[].conditions` to skip as needed.
For different cadences (nightly vs weekly), create separate workflows with different schedules.
For “since last run” drift checks, use a temporal window (e.g., review changes from the last 24 hours).
This is an intentional approximation and may miss or double-count changes if the schedule drifts or reruns.

Execution flow:
1) Scheduled workflow checks out the default branch.
2) For each `schedule.jobs[]`, evaluate conditions and spawn subagent.
3) If output is `pr_create`, apply changes and open PR.

Config shape:
```yaml
version: 1
commands:
  - id: docs-drift
    title: "Docs drift check"
    prompt: |
      Compare README and docs against current code behavior for changes in the last 24 hours.
      Use git history to identify recent changes and update docs if needed.
    tools:
      allow: [filesystem, git.history, repo.write, github.read]

schedule:
  enabled: true
  jobs:
    - id: docs-drift
      title: "Docs drift check"
      commandRef: docs-drift
      tools:
        allow: [filesystem, git.history, repo.write, github.read]
      output:
        mode: pr_create
        pr:
          base: main
          title: "Docs: fix drift"
          body: "Automated docs refresh"
      limits:
        maxFiles: 50
        maxDiffLines: 800
      conditions:
        paths:
          include: ["README.md", "docs/**"]
      writeScope:
        include: ["**/*.md"]
```

Key attributes and rationale:
- `output.mode`: `pr_create` | `issue`
  - `pr_create`: write changes and open PR.
  - `issue`: open an issue with a description-only report.
- `commandRef` (recommended): reference to a command defined under `commands`.
- `prompt` (inline): only for one-off jobs; use `commandRef` to reuse logic across triggers.
- `output.pr` (required for `pr_create`): base branch, title/body.
- `output.issue` (required for `issue`): title/body are optional; if title is omitted it defaults to the job `title`.
  - If body is omitted, use the subagent summary + findings in a short report.
- `limits.maxDiffLines`: guardrail to avoid giant PRs.
- `conditions`: repo-scoped filters (not PR-scoped):
  - `paths.include` / `paths.exclude` (glob match against repo contents)
  - `branch.include` / `branch.exclude` (target branch filter)
- `writeScope`: include/exclude globs limiting which paths can be modified (recommended when `repo.write` is allowed).
  - Example: allow any Markdown file with `**/*.md`.

PR creation behavior:
- Bot branch name is deterministic from the job id (internal strategy).
- If an existing bot PR is already open for that branch, update it instead of creating a new one.
- If no changes are needed, skip creating a PR.

Permissions (scheduled maintenance):
- `contents: write`
- `pull-requests: write`
- `issues: write` (if opening issues)

GITHUB_TOKEN limitation:
- PRs created by `GITHUB_TOKEN` do not trigger other workflows by default.
- This is still useful for low-risk changes (e.g., docs). If downstream CI is required, use a PAT or GitHub App token.
