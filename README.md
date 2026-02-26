# Shitty Reviewing Agent

**Disclaimer:** This project is experimental. It may produce incorrect reviews, miss issues, or behave unexpectedly. No guarantees are provided.

A GitHub Action that reviews PRs using an LLM-powered agent with repo tooling.

## Guiding Principle

This project intentionally favors a tools-first approach for frontier models: give the model strong tooling and rich context, then let it decide how to behave. Instead of hard-coded heuristics, we surface ambiguity and require explicit choices (e.g., pick a thread, choose LEFT/RIGHT side, or open a new thread). This is experimental and may evolve; it may or may not be the best approach, but it reflects the current direction of the project.

## Usage

```yaml
name: PR Review
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ghcr.io/yourname/shitty-reviewing-agent:latest
        with:
          provider: openrouter
          api-key: ${{ secrets.OPENROUTER_KEY }}
          model: anthropic/claude-sonnet-4
```

## Inputs

- `provider` (required unless set in `.reviewerc`): LLM provider supported by `@mariozechner/pi-ai` (e.g., google, anthropic, openai, openrouter). Aliases: `gemini` → `google`, `vertex`/`vertex-ai` → `google-vertex`.
- `api-key` (required unless using Vertex AI): API key for the provider. For Vertex AI, api-key is optional (ADC or key). When using ADC, set `GOOGLE_CLOUD_PROJECT` (or `GCLOUD_PROJECT`) and `GOOGLE_CLOUD_LOCATION`. For the Gemini API provider (`google`), use `GEMINI_API_KEY` locally/CI.
- `model` (required unless set in `.reviewerc`): Model name
- `compaction-model` (optional): Model used for context compaction summaries. Defaults to `gemini-3-flash-preview` when provider is `google`, otherwise uses `model`.
- `max-files` (optional, default `50`): Max files to review; skips if exceeded
- `ignore-patterns` (optional, default `*.lock,*.generated.*`): Comma-separated globs to skip
- `reasoning` (optional, default `off`): Thinking level (`off|minimal|low|medium|high|xhigh`)
- `temperature` (optional): Sampling temperature (0-2)
- `allow-pr-tools` (optional): Allow PR-creation tools in PR review mode (default false; schedule mode always allows them)
- `experimental-pr-explainer` (optional): Experimental toggle to post a PR-level review guide comment plus selective per-file explainer comments
- `bot-name` (optional): Bot/app mention name for `@bot command` triggers (e.g., `my-app`)
- `app-id` (optional): GitHub App ID (use instead of GITHUB_TOKEN)
- `app-installation-id` (optional): GitHub App installation ID
- `app-private-key` (optional): GitHub App private key PEM

## .reviewerc configuration

Place a `.reviewerc` file at the repo root to define custom commands and scheduled runs. Action inputs override `.reviewerc` values; `.reviewerc` overrides built-in defaults.

Example:
```yaml
version: 1
commands:
  - id: security
    prompt: "Review for authz bypass, unsafe deserialization, secrets, and input validation gaps."
review:
  defaults:
    provider: openrouter
    model: anthropic/claude-sonnet-4
  run: [security]
```

See `docs/reviewerc.example.yml` for a full example and `schemas/reviewerc.schema.json` for the full schema.
Use `review.allowPrToolsInReview: true` to enable PR-creation tools in PR review mode.
Use `review.experimental.prExplainer: true` to enable the experimental PR explainer (review guide + selective per-file explainer comments).

### Experimental PR explainer

Enable via action input:

```yaml
- uses: ghcr.io/victorarias/shitty-reviewing-agent:latest
  with:
    provider: google
    api-key: ${{ secrets.GEMINI_API_KEY }}
    model: gemini-3-pro-preview
    experimental-pr-explainer: true
```

Enable via `.reviewerc`:

```yaml
version: 1
review:
  experimental:
    prExplainer: true
```

Behavior when enabled:
- Posts one PR-level "Review Guide" issue comment.
- Posts selective explainer comments for meaningful changed files (inline when possible, issue-comment fallback for non-commentable/binary/large diffs).
- Disables the legacy auto-generated summary sequence diagram.
- For larger PRs (>3 distinct non-test/non-generated directories), the review guide must include both:
  - a Mermaid component relationship diagram
  - a Mermaid sequence diagram
- Required diagrams are validated with Mermaid's parser before posting.
- Skips generated/noise artifact files (for example lock/log/minified/map/snapshot/coverage artifacts) from per-file explainer comments.
- Allows partial explainer output; unknown file paths are ignored instead of failing the whole explainer run.
- If required diagrams are missing/invalid, or output is missing/not parseable JSON, posts an explicit failure signal comment.
- Mermaid snippets can be checked with the `validate_mermaid` tool (parser-backed via Mermaid's parser).

### Add reviewer-latest to CI

If you want CI to run the reviewer with this repository's patched dependencies (for example patched `@mariozechner/pi-ai`) on internal PRs, add a non-blocking job like this:

```yaml
reviewer-latest:
  if: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.fork == false }}
  needs: [test, harness]
  runs-on: ubuntu-latest
  permissions:
    contents: read
    pull-requests: write
  continue-on-error: true
  env:
    VERTEX_AI_API_KEY: ${{ secrets.VERTEX_AI_API_KEY }}
  steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0
    - uses: oven-sh/setup-bun@v1
      if: ${{ env.VERTEX_AI_API_KEY != '' }}
      with:
        bun-version: "1.3.9"
    - name: Skip reviewer when VERTEX_AI_API_KEY is missing
      if: ${{ env.VERTEX_AI_API_KEY == '' }}
      run: echo "Skipping reviewer-latest (VERTEX_AI_API_KEY not configured)."
    - name: Install dependencies (apply local patches)
      if: ${{ env.VERTEX_AI_API_KEY != '' }}
      run: bun install --frozen-lockfile
    - name: Verify pi-ai patch is active
      if: ${{ env.VERTEX_AI_API_KEY != '' }}
      run: grep -n "VERTEX_AI_API_KEY" node_modules/@mariozechner/pi-ai/dist/providers/google-vertex.js
    - name: Run reviewer from source (patched dependencies)
      if: ${{ env.VERTEX_AI_API_KEY != '' }}
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      run: |
        env \
          GITHUB_TOKEN="${GITHUB_TOKEN}" \
          INPUT_PROVIDER=google-vertex \
          INPUT_MODEL=gemini-3-flash-preview \
          INPUT_REASONING=minimal \
          INPUT_DEBUG=true \
          LLM_RATE_LIMIT_MAX_WAIT_MS=3600000 \
          LLM_RATE_LIMIT_MAX_ATTEMPTS=20 \
          "INPUT_API-KEY=${VERTEX_AI_API_KEY}" \
          bun src/index.ts
```

Notes:
- Secrets cannot be used directly in job-level `if`; gate at step level with an env variable instead.
- This path is intended for this repo's CI, so local dependency patches in `patches/` are applied via `postinstall`.

## Tools

Tools are grouped by allowlist categories. Commands can further restrict via `tools.allow`.

- `agent.subagent` (in-process delegation): `subagent`
- `terminate` (run control; always available, not allowlist-gated)
- `filesystem` (read-only): `read`, `grep`, `find`, `ls`, `validate_mermaid`
- `git.read` (PR diffs): `get_changed_files`, `get_full_changed_files`, `get_diff`, `get_full_diff`
- `git.history` (repo history): `git_log`, `git_diff_range`, `git` (read-only in PR mode; write-enabled in scheduled runs with restrictions)
- `github.pr.read` (PR metadata + context): `get_pr_info`, `get_review_context`, `list_threads_for_location`, `web_search` (Gemini/Google/Vertex only; Vertex requires `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`)
- `github.pr.feedback` (PR feedback): `comment`, `suggest`, `update_comment`, `reply_comment`, `resolve_thread`, `post_summary`
- `github.pr.manage` (PR creation): `push_pr` (schedule mode always; PR mode only if `allow-pr-tools` is true)
- `repo.write` (file edits): `write_file`, `apply_patch`, `delete_file`, `mkdir`
- `terminate` is always available and should be called exactly once as the final action.

Note: scheduled runs do not have PR context; PR-only tools (`git.read`, `github.pr.read`, `github.pr.feedback`) are not available there.


### Scheduled maintenance example

`.reviewerc`:
```yaml
version: 1

commands:
  - id: docs-drift
    title: "Docs drift check"
    prompt: |
      Detect outdated documentation based on recent code changes (last 7 days).
      Use git history to identify behavior changes and update README.md and docs accordingly.
      If changes should be reviewed, use git add <paths>, git commit -m <message>, then open a PR with push_pr.
    tools:
      allow: [filesystem, git.history, repo.write, github.pr.manage]

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
    include: ["README.md", "docs/**"]

tools:
  allowlist: [agent.subagent, filesystem, git.read, git.history, github.pr.read, github.pr.feedback, github.pr.manage, repo.write]
```

Workflow (weekly, Monday 08:00 Stockholm time / 07:00 UTC):
```yaml
name: Reviewer Maintenance

on:
  schedule:
    - cron: "0 7 * * 1"
  workflow_dispatch:
    inputs:
      run_docs:
        description: "Run docs drift job"
        type: boolean
        required: false
        default: true

permissions:
  contents: write
  pull-requests: write

jobs:
  docs-upkeep:
    if: ${{ github.event_name == 'schedule' || inputs.run_docs }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: ghcr.io/victorarias/shitty-reviewing-agent:latest
        with:
          provider: vertex-ai
          model: gemini-3-pro-preview
        env:
          GOOGLE_CLOUD_PROJECT: ${{ secrets.GOOGLE_CLOUD_PROJECT }}
          GOOGLE_CLOUD_LOCATION: ${{ secrets.GOOGLE_CLOUD_LOCATION }}
```

## Notes

- Requires `actions/checkout` so files are available locally.
- Uses the implicit `GITHUB_TOKEN` for PR metadata and comments (no extra setup required).
- Docker runtime uses Bun to execute the TypeScript sources directly (no committed `dist/` artifacts).
- For PRs touching more than 3 distinct directories, the summary includes a Mermaid sequence diagram in a collapsible `<details>` block.
- When `experimental-pr-explainer` (or `review.experimental.prExplainer`) is enabled, the agent also posts:
  - one PR-level "Review Guide" comment
  - for larger PRs (>3 distinct non-test/non-generated directories), the review guide includes both a Mermaid component relationship diagram and a Mermaid sequence diagram
  - selective explainer comments for meaningful changed files (inline when possible, issue-comment fallback for non-commentable/binary/large diffs)
  - the legacy auto-generated summary sequence diagram is disabled
- The reviewer tracks issues via tools to populate summary counts; if no issues are recorded, the table will show zeros.
- Follow-up reviews keep the summary delta-focused on new changes; unchanged prior findings are not repeated. Follow-up summaries split findings into "New Issues Since Last Review" and "Resolved Since Last Review".
- For large reviews, the agent may prune earlier context and inject a short context summary to stay within model limits.
- LLM calls automatically retry with exponential backoff on rate limits (including 429/RESOURCE_EXHAUSTED), respecting Retry-After when present and waiting up to ~60 minutes total by default. Override via `LLM_RATE_LIMIT_MAX_WAIT_MS` and `LLM_RATE_LIMIT_MAX_ATTEMPTS`.
- Comment-triggered commands use `!command` or `@bot command` in PR comments (requires `issue_comment` workflow).
- Scheduled runs read `schedule.runs[GITHUB_JOB]` from `.reviewerc`. The agent should use `git add` + `git commit`, then `push_pr` to open or update a PR.
- Manual `workflow_dispatch` runs use the same schedule flow and `schedule.runs[GITHUB_JOB]` mapping.
- Scheduled PR descriptions include the model + billing footer when the agent calls `push_pr`.

Minimal workflow (implicit token):

```yaml
permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ghcr.io/victorarias/shitty-reviewing-agent:latest
        with:
          provider: google
          api-key: ${{ secrets.GEMINI_API_KEY }}
          model: gemini-3-pro-preview
          reasoning: medium
```

## Gemini 3 Pro Recommendations

Prompts are optimized for Gemini 3 Pro. Recommendations:

- **Temperature**: Leave at default (1.0). Lower values may cause looping or degraded behavior.
- **Reasoning**: Use `medium` or higher for complex PRs. Gemini 3 maps `off/minimal/low` → `low` and `medium/high/xhigh` → `high` internally.

```yaml
- uses: ghcr.io/victorarias/shitty-reviewing-agent:latest
  with:
    provider: google
    api-key: ${{ secrets.GEMINI_API_KEY }}
    model: gemini-3-pro-preview
    reasoning: medium  # recommended for thorough reviews
```

## Reasoning & temperature

```yaml
- uses: ghcr.io/victorarias/shitty-reviewing-agent:latest
  with:
    provider: google
    api-key: ${{ secrets.GEMINI_API_KEY }}
    model: gemini-3-pro-preview
    reasoning: medium
```

## GitHub App auth (optional)

By default, the action uses the implicit `GITHUB_TOKEN`. If you want to authenticate as a GitHub App instead, **create your own GitHub App** and use *your* App ID, Installation ID, and private key.

```yaml
- uses: ghcr.io/yourname/shitty-reviewing-agent:latest
  with:
    provider: google
    api-key: ${{ secrets.GEMINI_API_KEY }}
    model: gemini-3-pro-preview
    app-id: ${{ secrets.MY_APP_ID }}
    app-installation-id: ${{ secrets.MY_APP_INSTALLATION_ID }}
    app-private-key: ${{ secrets.MY_APP_PRIVATE_KEY }}
```


## Local smoke run

Requires `bun` installed locally.

```bash
bun run smoke --provider openrouter --api-key "$OPENROUTER_KEY" --model anthropic/claude-sonnet-4 --repo owner/name --pr 123 --token "$GITHUB_TOKEN" --reasoning low --temperature 0.2
```

## Release

Push a tag like `v0.1.0` to build and publish the image to GHCR via `.github/workflows/release.yml`.
