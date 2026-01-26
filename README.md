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

- `provider` (required): LLM provider supported by `@mariozechner/pi-ai` (e.g., google, anthropic, openai, openrouter). Aliases: `gemini` → `google`, `vertex`/`vertex-ai` → `google-vertex`.
- `api-key` (required unless using Vertex AI): API key for the provider. Vertex AI uses ADC instead.
- `model` (required): Model name
- `compaction-model` (optional): Model used for context compaction summaries. Defaults to `gemini-3-flash-preview` when provider is `google`, otherwise uses `model`.
- `max-files` (optional, default `50`): Max files to review; skips if exceeded
- `ignore-patterns` (optional, default `*.lock,*.generated.*`): Comma-separated globs to skip
- `reasoning` (optional, default `off`): Thinking level (`off|minimal|low|medium|high|xhigh`)
- `temperature` (optional): Sampling temperature (0-2)
- `app-id` (optional): GitHub App ID (use instead of GITHUB_TOKEN)
- `app-installation-id` (optional): GitHub App installation ID
- `app-private-key` (optional): GitHub App private key PEM

## Notes

- Requires `actions/checkout` so files are available locally.
- Uses the implicit `GITHUB_TOKEN` for PR metadata and comments (no extra setup required).
- Docker runtime uses Bun to execute the TypeScript sources directly (no committed `dist/` artifacts).
- For PRs touching more than 3 distinct directories, the summary includes a Mermaid sequence diagram in a collapsible `<details>` block.
- The reviewer tracks issues via tools to populate summary counts; if no issues are recorded, the table will show zeros.
- Follow-up reviews keep the summary delta-focused on new changes; unchanged prior findings are not repeated. Follow-up summaries split findings into "New Issues Since Last Review" and "Resolved Since Last Review".
- For large reviews, the agent may prune earlier context and inject a short context summary to stay within model limits.
- LLM calls automatically retry with exponential backoff on rate limits (including 429/RESOURCE_EXHAUSTED), respecting Retry-After when present and waiting up to ~15 minutes total.

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
node scripts/smoke.mjs --provider openrouter --api-key "$OPENROUTER_KEY" --model anthropic/claude-sonnet-4 --repo owner/name --pr 123 --token "$GITHUB_TOKEN" --reasoning low --temperature 0.2
```

## Release

Push a tag like `v0.1.0` to build and publish the image to GHCR via `.github/workflows/release.yml`.
