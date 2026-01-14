# Shitty Reviewing Agent - Design

A GitHub Action that reviews PRs using LLMs.

## Intent & Motivation

### Why this exists

Automated PR reviews that actually help. Most existing solutions either:
- Only lint/static analysis (miss semantic issues)
- Dump the whole diff into an LLM and hope for the best (no codebase context)
- Require complex setup (GitHub Apps, webhooks, infrastructure)

This agent is different: it's an **agent with tools**, not a single prompt. It can explore the codebase, understand context, and make informed comments.

### Design principles

**Simple to adopt**: One workflow file, three required inputs (provider, api-key, model). No GitHub App, no webhooks, no external services. Trigger however you want (PR open, manual, label - your workflow, your rules).

**Agent-driven, not template-driven**: The LLM decides how to review. It gets tools and a goal. It can read related files, grep for usages, understand impact. This means it can catch things like "this change breaks callers" or "this duplicates existing code in another file".

**Full file context**: Reviewing just the diff misses too much. A one-line change might introduce a bug that's only visible when you see the surrounding code. The agent reads full files, not just hunks.

**Actionable output**: GitHub suggestion blocks for single-file fixes (one-click accept). Inline comments on specific lines. A summary that tells you what matters. Not a wall of text.

**AGENTS.md cultivation**: This is a unique feature. The reviewer doesn't just check code - it helps maintain agent instructions. If code violates documented patterns, flag it. If code introduces good patterns, suggest documenting them. This creates a feedback loop that improves future agent work.

**Fail loudly**: When something goes wrong (too many files, API errors), tell the user clearly. Never silently skip files or swallow errors.

### Why these technology choices

**pi-mono (`@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`)**: Unified LLM interface that supports OpenRouter, Gemini, Anthropic, OpenAI, etc. No need to write provider-specific code. The agent-core package provides battle-tested file tools (read, grep, find, ls) so we don't reinvent that wheel.

**Container image**: Predictable environment. No "works on my machine". The action just runs - all dependencies pre-installed, no setup step.

**`@actions/github` for PR operations**: Standard library, well-documented, handles auth automatically via GITHUB_TOKEN. We only need ~5 custom tools for PR-specific operations.

**No MCP**: pi-mono deliberately doesn't implement MCP. We could run GitHub's MCP server as a sidecar, but that adds complexity for minimal benefit. Writing 5 thin wrapper tools around Octokit is simpler than managing a sidecar process and MCP client.

### What this is NOT

- **Not a linter replacement**: This catches semantic issues, not formatting. Run your linters separately.
- **Not a security scanner**: It may catch obvious security issues, but don't rely on it. Use dedicated security tools.
- **Not a CI gate**: It posts comments and suggestions. It doesn't block merges. That's your decision.

## Overview

Agent-driven PR reviewer that:
- Analyzes full changed files (not just diffs) with PR description context
- Finds bugs, security issues, performance problems, unused code, duplication, refactoring opportunities
- Suggests documentation updates (AGENTS.md/CLAUDE.md awareness)
- Posts inline comments with GitHub suggestion blocks for fixes
- Generates a summary brief

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  GitHub Workflow                     │
│         uses: ghcr.io/you/shitty-reviewing-agent    │
└─────────────────┬───────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────┐
│           Container: shitty-reviewing-agent         │
│                                                     │
│   ┌─────────────────────────────────────────────┐   │
│   │              Agent Loop (pi-ai)              │   │
│   │                                              │   │
│   │   System prompt + tools → iterative review   │   │
│   │                                              │   │
│   └──────────────────┬──────────────────────────┘   │
│                      │                              │
│   ┌──────────────────▼──────────────────────────┐   │
│   │                 Tools                        │   │
│   │  ┌────────────┐ ┌────────────┐ ┌──────────┐ │   │
│   │  │    read    │ │   grep     │ │   find   │ │   │
│   │  │ (pi-mono)  │ │ (pi-mono)  │ │(pi-mono) │ │   │
│   │  └────────────┘ └────────────┘ └──────────┘ │   │
│   │  ┌────────────┐ ┌────────────┐ ┌──────────┐ │   │
│   │  │get_pr_info │ │  get_diff  │ │ comment  │ │   │
│   │  │  (custom)  │ │  (custom)  │ │ (custom) │ │   │
│   │  └────────────┘ └────────────┘ └──────────┘ │   │
│   │  ┌────────────┐ ┌────────────────────────┐  │   │
│   │  │  suggest   │ │     post_summary       │  │   │
│   │  │  (custom)  │ │       (custom)         │  │   │
│   │  └────────────┘ └────────────────────────┘  │   │
│   └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

## Tools

The agent needs two kinds of tools: filesystem tools (to explore the codebase) and GitHub tools (to interact with the PR). We reuse pi-mono's filesystem tools and write custom GitHub tools.

**Why this split?** The repo is checked out locally via `actions/checkout`, so filesystem operations are fast, free, and don't hit rate limits. GitHub API is only used for PR-specific operations that can't be done locally (getting PR metadata, posting comments).

### From pi-mono (`createReadOnlyTools`)

| Tool | Purpose |
|------|---------|
| `read` | Read file contents |
| `grep` | Search for patterns in codebase |
| `find` | Find files by pattern |
| `ls` | List directory contents |

### Custom GitHub tools

| Tool | Purpose |
|------|---------|
| `get_pr_info` | Get PR title, description, author, base/head branches |
| `get_changed_files` | List files changed in PR (paths + status: added/modified/deleted) |
| `get_diff` | Get diff for a specific file |
| `comment` | Post inline comment on specific line |
| `suggest` | Post GitHub suggestion block (single-hunk fix) |
| `post_summary` | Post final review brief as PR comment |

## Issue Categories

- Bugs and logic errors
- Security vulnerabilities
- Performance issues
- Unused code caused by changes
- Duplicated code
- Refactoring opportunities
- Documentation updates (AGENTS.md/CLAUDE.md)

NOT included: style/conventions (too noisy - linters do this better, and style comments feel nitpicky from an automated reviewer)

## AGENTS.md/CLAUDE.md Awareness

Bidirectional cultivation of agent instructions:

1. **Find deviations**: Read relevant AGENTS.md files (root + nearest to changed files). Flag code that violates documented patterns.

2. **Capture new patterns**: If the PR introduces conventions, architectures, or approaches that agents should know about, suggest adding them to the appropriate AGENTS.md:
   - Root `/AGENTS.md` = project-wide patterns, architecture decisions
   - Deep `/path/to/AGENTS.md` = package/module-specific conventions

Examples of patterns worth capturing:
- "Services in this package always use constructor injection"
- "Error responses follow { error: string, code: number } shape"
- "Tests use factory functions, not raw fixtures"

## Fix Suggestions

**Why not push commits?** Modifying the PR branch adds complexity (branch permissions, merge conflicts, force pushes) and takes control away from the author. Suggestion blocks are non-invasive - the author decides what to accept.

- **Single-hunk**: GitHub suggestion blocks (native UI, one-click accept)
- **Multi-file**: Pseudo-code description in relevant comment, or in summary brief if doesn't fit

Multi-file refactors can't be expressed as suggestion blocks, so we describe them in prose with pseudo-code. The agent should attach these to the most relevant line, or put them in the summary if there's no clear anchor point.

## Configuration

### action.yml inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `provider` | yes | - | LLM provider (openrouter, gemini, anthropic, openai, etc.) |
| `api-key` | yes | - | API key for the LLM provider |
| `model` | yes | - | Model to use (e.g., anthropic/claude-sonnet-4) |
| `max-files` | no | 50 | Max files to review (skips if exceeded) |
| `ignore-patterns` | no | `*.lock,*.generated.*` | Comma-separated glob patterns to skip |

### Example workflow

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

## Error Handling

| Scenario | Behavior |
|----------|----------|
| PR exceeds max-files | Post summary explaining skip, exit 0 |
| LLM API fails | Retry 2x with backoff, then post error comment, exit 1 |
| GitHub API rate limit | Post warning comment, exit 1 |
| Checkout missing | Fail fast with clear error |
| Invalid config | Fail fast before any API calls |

## Agent Loop Limits

Agents can loop forever if not constrained. We cap iterations based on expected work.

- **Max iterations**: `10 + (max_files × 5)`
- Derived from max-files, not separately configurable (one less knob to tune)
- If agent doesn't call `post_summary` by limit, force a summary with findings so far (never leave the PR without feedback)

### Estimation basis

Per-file work: ~4-6 tool calls (get_diff, read, grep, comment, suggest)
Fixed overhead: ~5-6 calls (get_pr_info, get_changed_files, AGENTS.md reads, post_summary)

| max-files | Max iterations |
|-----------|----------------|
| 10 | 60 |
| 20 | 110 |
| 50 (default) | 260 |

## Summary Brief Format

Posted as PR comment:

```markdown
## Review Summary

**Verdict:** Request Changes | Approve | Skipped

### Issues Found

| Category | Count |
|----------|-------|
| Bugs | 2 |
| Security | 1 |
| Performance | 0 |
| Unused Code | 1 |
| Duplicated Code | 0 |
| Refactoring | 2 |
| Documentation | 1 |

### Key Findings

- **src/auth.ts:42** - SQL injection via unsanitized input
- **src/utils.ts** - `formatDate` is now unused after this PR
- **packages/api/AGENTS.md** - Should document the new retry pattern

### Multi-file Suggestions

> The error handling in `api/` and `web/` could share a base class.
> See `src/api/errors.ts:15` and `src/web/errors.ts:20`.

---
*Reviewed by shitty-reviewing-agent • model: {model from input}*
```

## Project Structure

```
shitty-reviewing-agent/
├── action.yml              # GitHub Action definition
├── Dockerfile              # Container build
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts            # Entry point
│   ├── agent.ts            # Agent loop setup with pi-ai
│   ├── prompt.ts           # System prompt
│   ├── tools/
│   │   ├── index.ts        # Export all tools
│   │   ├── github.ts       # get_pr_info, get_changed_files, get_diff
│   │   └── review.ts       # comment, suggest, post_summary
│   └── types.ts            # Shared types
└── README.md
```

## Dependencies

- `@mariozechner/pi-ai` - LLM abstraction (multi-provider)
- `@mariozechner/pi-agent-core` - Agent runtime + file tools
- `@actions/core` - Read inputs, set outputs
- `@actions/github` - Octokit client for GitHub API

## Tech Stack

- TypeScript
- Container: `node:20-slim`
- Pre-installed: all dependencies
- Entrypoint: `node /app/dist/index.js`

## Implementation Notes

### For the implementing agent

1. **Start with pi-mono research**: Before writing code, read pi-mono's docs - especially `@mariozechner/pi-ai` for the LLM interface and `@mariozechner/pi-agent-core` for the agent loop and tool creation. Understand how `createReadOnlyTools()` works.

2. **Get the GitHub tools working first**: The custom tools (get_pr_info, get_diff, comment, suggest, post_summary) are the novel part. Test them against a real PR before wiring up the agent.

3. **The prompt is critical**: The system prompt defines review quality. Iterate on it. Be specific about what "good" looks like for each issue category.

4. **Test locally**: You can test the agent locally by setting environment variables that mimic the GitHub Actions context (GITHUB_TOKEN, GITHUB_REPOSITORY, PR number via GITHUB_EVENT_PATH).

5. **Handle edge cases**:
   - Binary files in the diff (skip them)
   - Deleted files (can't comment on them, mention in summary)
   - Very large files (may need to truncate for context window)
   - PRs with no changed files (just post "nothing to review")

6. **Suggestion block format**: GitHub suggestion blocks have specific markdown syntax:
   ````markdown
   ```suggestion
   corrected code here
   ```
   ````
   Make sure the `suggest` tool generates this correctly, including proper line targeting.

### What success looks like

- User adds workflow file with 3 inputs
- Opens a PR
- Within minutes, gets inline comments on specific issues
- Gets suggestion blocks they can accept with one click
- Gets a summary that tells them verdict + key issues
- If AGENTS.md patterns are relevant, gets suggestions to update them
