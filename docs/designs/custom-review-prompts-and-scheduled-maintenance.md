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
- Schema: `schemas/reviewerc.schema.json` (authoritative structure + allowed values, strict `additionalProperties: false`)

## Comment-triggered commands (App or Action)

In addition to PR-time and scheduled runs, commands can be triggered on demand from PR comments:

- **App mode**: `@app-name command [args...]`
- **Action mode**: `!command [args...]`

Commands are predefined in `.reviewerc` and referenced by `id`. Only known commands are allowed.
These commands always run in PR context. If invoked outside a PR, the action ignores the request.
Unknown commands are ignored (silent no-op).
Action mode requires a workflow listening on `issue_comment` events. App mode requires the GitHub App
to receive issue comment events and run the action.

Commands are the canonical prompt definitions. Triggers reference commands by id.

## Workflow-provided context (extra checkouts)

This design intentionally keeps `.reviewerc` focused on prompt behavior, not workflow orchestration.
Teams can extend context in the workflow itself:

- **Extra repos**: Clone additional repositories before running the action (e.g., `company-rules/`).
  Prompts can read those files by path (e.g., `company-rules/docs/api-rules.md`).
  Example prompt line: \"Apply the rules in company-rules/docs/api-rules.md to the changes in this repo.\"

Example workflow + `.reviewerc` snippet:
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
---
# .reviewerc
commands:
  - id: rules-check
    prompt: |
      Apply the rules in company-rules/docs/api-rules.md to the changes in this repo.
schedule:
  enabled: true
  runs:
    nightly-rules: [rules-check]
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
- `github.pr`: `commit_changes`, `push_pr`
  - Why: agent-driven scheduled PR creation.
- `repo.write`: write local files (scheduled jobs only)
  - Why: enables maintenance edits prior to committing.

Safety guardrails for scheduled PRs:
- Never push directly to the base branch; always create/update a bot branch and open a PR via `push_pr`.
- Branch names are deterministic (based on job + command ids) unless explicitly overridden in the tool call.
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
- `both`: post inline review comments for line-anchored findings and a top-level issue summary.

Default: `both` for command-triggered runs unless overridden by `command.comment.type` or `output.commentType`.
`review` and `both` only apply to PRs.

Scheduled runs do not have PR context. PR-only tools (e.g., `get_pr_info`, `get_changed_files`, `get_diff`, review comments)
are unavailable in scheduled jobs and should not be expected to work there.

`git.history` tool sketch (scheduled jobs):
- `git_log`: list commits in a time window (e.g., `sinceHours`, optional `paths`).
- `git_diff_range`: diff between two refs (e.g., `from`, `to`, optional `paths`).

## Shared prompt module model

Commands define reusable prompt modules. Triggers reference them by id.

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

Trigger parsing example:
- `!docs-drift "last 48 hours" --scope docs/`

## Trigger lists (simplified)

Use trigger lists to declare which commands run in each mode:

- `review.run`: commands that run on every PR.
- `schedule.runs`: map of workflow job id → commands that run in that scheduled job.

Example:
```yaml
commands:
  - id: security
    prompt: "Review for authz bypass, unsafe deserialization, secrets, and input validation gaps."
  - id: docs-drift
    prompt: "Check docs drift for the last 24 hours."

review:
  run: [security]
schedule:
  runs:
    nightly-docs: [docs-drift]
```

Common output contract from subagents:
- `summary`: short overview
- `findings[]`: `{ title, severity, location?, details, suggestion? }`
- `notes[]`: non-blocking observations
- `confidence`: `low` | `medium` | `high`

## Plan A: PR-time custom review prompts

Execution flow:
1) Main reviewer gathers PR context.
2) For each `review.run` command id, run the command.

Event routing (Action mode):
- `pull_request` → run main review + `review.run`
- `issue_comment` → parse `!command` / `@bot command` and run only that command (PR comments only)
- `schedule` → read `schedule.runs[GITHUB_JOB]` and run those commands

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
  run: [security]
  defaults:
    provider: openrouter
    model: anthropic/claude-sonnet-4
    reasoning: medium
    temperature: 0.4
```

Key attributes and rationale:
- `review.run`: list of command ids to run on every PR.
- `review.defaults`: default model settings for PR runs.

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
2) Look up `schedule.runs[GITHUB_JOB]` (job id → command list). If missing, do nothing.
3) Run the command ids listed for that job.
4) Apply changes and open a PR (the only supported scheduled output).

Config shape:
```yaml
version: 1
commands:
  - id: docs-drift
    title: "Docs drift check"
    prompt: |
      Compare README and docs against current code behavior for changes in the last 24 hours.
      Use git history to identify recent changes and update docs if needed.
      If you make changes that should be reviewed, commit them with commit_changes and open a PR with push_pr.
    tools:
      allow: [filesystem, git.history, repo.write, github.pr]

schedule:
  enabled: true
  runs:
    nightly-docs: [docs-drift]
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
- `schedule.runs`: map of job id → list of command ids to run for that scheduled job.
- `schedule.limits`: guardrails to avoid giant PRs.
- `schedule.conditions`: repo-scoped filters (not PR-scoped).
- `schedule.writeScope`: include/exclude globs limiting which paths can be modified.

PR creation behavior:
- PRs are agent-driven: the scheduled command must call commit_changes and push_pr.
- The PR targets the repo default branch (not configurable).
- Bot branch name is deterministic from the scheduled job + command ids (internal strategy).
- If an existing bot PR is already open for that branch, push_pr updates it instead of creating a new one.
- If no committed changes are present, push_pr fails with a clear error.

Permissions (scheduled maintenance):
- `contents: write`
- `pull-requests: write`

GITHUB_TOKEN limitation:
- PRs created by `GITHUB_TOKEN` do not trigger other workflows by default.
- This is still useful for low-risk changes (e.g., docs). If downstream CI is required, use a PAT or GitHub App token.
