# Prompt Engineering for Agents

This guide covers how to craft system prompts and user prompts that effectively steer agent behavior.

## Two Prompts, Two Purposes

| Prompt Type | Purpose | When to Modify |
|-------------|---------|----------------|
| **System prompt** | Define role, constraints, workflow | At agent design time |
| **User prompt** | Provide context, task, dynamic state | Per-task execution |

```typescript
const agent = new Agent({
  initialState: {
    systemPrompt: "...",  // Fixed identity
    // ...
  },
});

await agent.prompt(userPrompt);  // Dynamic task
```

## System Prompt Structure

A well-structured system prompt has distinct sections:

```typescript
const systemPrompt = `
# Role
[Who the agent is and what it does]

# Constraints
[Hard rules the agent must follow]

# Workflow
[Step-by-step process to follow]

# Style
[Tone, format, communication preferences]

# Tool Usage
[When and how to use specific tools]
`;
```

### Example: PR Review Agent

```typescript
const systemPrompt = `
# Role
You are a code reviewer that analyzes pull requests for bugs, security issues,
performance problems, and logic errors. You focus on substantive issues, not
style (leave formatting to linters).

# Constraints
- Call post_summary exactly once as your final action, then stop
- Do not continue after calling post_summary
- Never modify code directly - only comment and suggest
- For follow-up reviews, acknowledge what changed since the last review

# Workflow
1. Call get_pr_info to understand the PR context
2. Call get_changed_files to see what files changed
3. Call get_review_context to check for existing threads
4. For each file:
   a. Call get_diff to see changes
   b. If more context needed, use read to see surrounding code
   c. Post comments/suggestions as you find issues
5. Call post_summary with your verdict (Approve/Request Changes/Comment)

# Style
- Be direct and specific
- Explain why something is a problem, not just that it is
- Provide actionable suggestions

# Tool Usage
- Use suggest for code changes, comment for explanations
- When replying to existing threads, use thread_id parameter
- If multiple threads exist at a location, pick the most recent active one
`;
```

## Section-by-Section Guidance

### Role Section

**Purpose**: Establish the agent's identity and primary function.

**Good patterns**:
```typescript
// Clear, specific role
"You are a code reviewer that analyzes pull requests for bugs and security issues."

// Bounded scope
"You review code. You do not write code, refactor, or make direct changes."

// Clear non-goals (what to avoid)
"Focus on bugs and logic errors. Leave style and formatting to linters."
```

**Anti-patterns**:
```typescript
// Too vague
"You are a helpful assistant."

// Unbounded
"You help with anything related to code."

// Aspirational but meaningless
"You are the world's best code reviewer who never misses a bug."
```

### Constraints Section

**Purpose**: Define hard rules that should never be violated.

**Good patterns**:
```typescript
// Clear termination condition
"Call post_summary exactly once as your final action, then stop."

// Explicit prohibition
"Never commit code or push to remote repositories."

// Concrete limits
"Review at most 50 files. If more files changed, skip the review."
```

**Structure for constraints**:
1. Must-do requirements (positive constraints)
2. Must-not-do prohibitions (negative constraints)
3. Conditional rules (if X then Y)

```typescript
const constraints = `
# Constraints

## Required
- Call post_summary before stopping
- Read files before commenting on them
- Check for existing threads before creating new ones

## Prohibited
- Do not modify files
- Do not post duplicate comments
- Do not continue after post_summary

## Conditional
- If multiple threads exist at a location, you must specify which to reply to
- If the file is over 1000 lines, read it in chunks
- If you encounter a rate limit, stop and report the error
`;
```

### Workflow Section

**Purpose**: Define the sequence of actions the agent should follow.

**Good patterns**:
```typescript
// Numbered steps
`
1. Gather context: call get_pr_info and get_changed_files
2. Check history: call get_review_context
3. Review files: iterate through changed files
4. Post summary: call post_summary with verdict
`

// Explicit loops
`
For each changed file:
  a. Get the diff
  b. Read surrounding context if needed
  c. Post comments on issues found
`

// Clear termination
`
After posting the summary, stop. Do not make additional tool calls.
`
```

**Anti-patterns**:
```typescript
// Vague ordering
"Review the PR and post comments as needed."

// Implicit termination
"When you're done, post a summary."  // When is "done"?

// Missing steps
"Review files and post summary."  // How to review?
```

### Style Section

**Purpose**: Define tone, format, and communication preferences.

```typescript
const style = `
# Style

## Tone
- Direct and specific
- Explain the "why", not just the "what"
- Constructive, not critical

## Format
- Use code blocks for code references
- Keep comments concise (2-3 sentences)
- Structure longer comments with bullet points

## Communication
- Address the PR author directly ("you" not "the author")
- Acknowledge good patterns, not just problems
- If uncertain, phrase as a question
`;
```

### Tool Usage Section

**Purpose**: Provide guidance on when and how to use specific tools.

```typescript
const toolUsage = `
# Tool Usage

## read
- Use to see full file context, not just diffs
- Prefer reading related files to making assumptions
- Read before commenting on code you haven't seen

## comment vs suggest
- Use suggest for concrete code changes
- Use comment for explanations, questions, or broader concerns
- A suggest without explanation is acceptable if the fix is obvious

## Thread handling
- Always check for existing threads before creating new ones
- When replying, use thread_id to maintain conversation continuity
- If ambiguous (multiple threads at same location), specify which to reply to
`;
```

## User Prompt Structure

User prompts provide dynamic context for each task:

```typescript
function buildUserPrompt(pr: PullRequest, previousReview?: Review): string {
  let prompt = `
## PR Information
- Title: ${pr.title}
- Author: ${pr.author}
- Base: ${pr.base} ← Head: ${pr.head}

## Description
${pr.body || "(no description)"}

## Changed Files (${pr.files.length})
${pr.files.map(f => `- ${f.filename}`).join("\n")}
`;

  if (previousReview) {
    prompt += `
## Previous Review
- Verdict: ${previousReview.verdict}
- Date: ${previousReview.date}
- URL: ${previousReview.url}

This is a follow-up review. Compare against the previous review and focus on:
- New changes since last review
- Whether previous feedback was addressed
- Any new issues introduced
`;
  }

  prompt += `
## Task
Review this PR. Start by calling get_pr_info and get_changed_files.
`;

  return prompt;
}
```

### Key Elements of User Prompts

1. **Context data** - Facts the agent needs to know
2. **State indicators** - What state the system is in (first review vs follow-up)
3. **Explicit task** - What to do with the context
4. **Starting point** - Which tool to call first (reduces ambiguity)

### Adaptive User Prompts

Adjust the user prompt based on context:

```typescript
function buildUserPrompt(context: ReviewContext): string {
  const parts: string[] = [];

  // Always include basic info
  parts.push(formatPrInfo(context.pr));

  // Conditional sections based on state
  if (context.isFollowUp) {
    parts.push(formatPreviousReview(context.previousReview));
    parts.push(`
Note: This is a follow-up review. ${context.newCommits} commits since last review.
Focus on what changed, not what was already reviewed. Summarize new issues and resolved items only.
`);
  }

  if (context.hasExistingThreads) {
    parts.push(`
Note: There are ${context.threadCount} existing review threads.
Check get_review_context before posting new comments.
`);
  }

  if (context.fileCount > 20) {
    parts.push(`
Note: This is a large PR (${context.fileCount} files).
Prioritize files that are most likely to have issues.
`);
  }

  // Always end with explicit task
  parts.push(`
Task: Review this PR. Start by calling get_pr_info and get_changed_files.
`);

  return parts.join("\n\n");
}
```

## Steering Through Prompts

### Explicit Instructions Over Implicit Hopes

**Bad**: Hoping the model infers correct behavior
```typescript
"Review the PR carefully."
```

**Good**: Explicit behavioral requirements
```typescript
"Review the PR. For each issue found:
1. Read the full file, not just the diff
2. Check if a similar comment already exists
3. If so, reply to the existing thread
4. If not, create a new comment with line reference"
```

### Negative Constraints

Tell the agent what NOT to do:

```typescript
const constraints = `
Do NOT:
- Post duplicate comments (check existing threads first)
- Comment on style/formatting issues (leave to linters)
- Make assumptions about code you haven't read
- Continue after calling post_summary
`;
```

### Conditional Behavior

Use if/then patterns for edge cases:

```typescript
const conditionalBehavior = `
- If a file is binary, skip it
- If a file is over 1000 lines, read it in 500-line chunks
- If you find a security issue, mark it as HIGH priority
- If multiple threads exist at the same location, pick the most recently active one
- If the PR has no description, note this in your summary
`;
```

### Termination Conditions

Be explicit about when to stop:

```typescript
// Explicit termination
"Call post_summary exactly once as your final action. After calling post_summary, do not make any more tool calls."

// Conditional termination
"If you encounter a rate limit error, stop immediately and report the error."

// Bounded iteration
"Review at most 50 files. If more files exist, note that the review was partial."
```

## Common Patterns

### The Workflow Pattern

Structure the agent's work as explicit steps:

```typescript
const workflowPrompt = `
Follow this workflow:

1. GATHER: Call get_pr_info and get_changed_files to understand the PR
2. CONTEXT: Call get_review_context to see existing discussions
3. ANALYZE: For each changed file, get the diff and read surrounding code
4. COMMENT: Post comments/suggestions as issues are found
5. SUMMARIZE: Call post_summary with your overall verdict

Do not skip steps. Do not reorder steps.
`;
```

### The Checklist Pattern

Give the agent a checklist to verify:

```typescript
const checklistPrompt = `
For each file, check:
- [ ] Logic errors or bugs
- [ ] Security vulnerabilities (injection, auth bypass, etc.)
- [ ] Performance issues (N+1 queries, unnecessary allocations)
- [ ] Error handling gaps
- [ ] Edge cases not covered

Only comment on issues you actually find. Do not invent issues.
`;
```

### The Persona Pattern

Define how the agent should communicate:

```typescript
const personaPrompt = `
Communication style:
- Be direct but respectful
- Explain the "why" behind feedback
- Acknowledge good patterns, not just problems
- If uncertain, phrase as a question rather than a statement
- Use code examples when suggesting changes
`;
```

### The Priority Pattern

Tell the agent what matters most:

```typescript
const priorityPrompt = `
Priority order for issues:
1. Security vulnerabilities (always comment)
2. Bugs and logic errors (always comment)
3. Performance issues (comment if significant)
4. Code clarity (comment if confusing)
5. Style/formatting (do NOT comment, leave to linters)
`;
```

## Testing Your Prompts

### Prompt Debugging Checklist

1. **Is the role clear?** - Does the agent know what it is?
2. **Are constraints explicit?** - Are hard rules stated as rules?
3. **Is the workflow defined?** - Are steps numbered and ordered?
4. **Is termination clear?** - Does the agent know when to stop?
5. **Are edge cases handled?** - What happens in unusual situations?

### Observing Prompt Effects

```typescript
agent.subscribe((event) => {
  if (event.type === "message_end" && event.message.role === "assistant") {
    // Log what the agent says to understand its reasoning
    const textContent = event.message.content.find(c => c.type === "text");
    if (textContent) {
      console.log("Agent reasoning:", textContent.text);
    }
  }
});
```

### Iterative Refinement

1. Run the agent on a real task
2. Observe where behavior diverges from expectations
3. Add explicit guidance for that case
4. Repeat

```typescript
// Version 1: Basic
"Review the PR and post comments."

// Version 2: After observing duplicate comments
"Review the PR. Check existing threads before posting new comments."

// Version 3: After observing missed context
"Review the PR. Read full files, not just diffs. Check existing threads before posting."

// Version 4: After observing no termination
"Review the PR. Read full files. Check existing threads. Call post_summary exactly once when done, then stop."
```

## Summary

1. **Structure prompts into sections**: Role, Constraints, Workflow, Style, Tool Usage
2. **Be explicit**: State requirements as requirements, not hopes
3. **Define termination**: Tell the agent when and how to stop
4. **Handle edge cases**: Use conditional rules for unusual situations
5. **Iterate on real tasks**: Refine prompts based on observed behavior
