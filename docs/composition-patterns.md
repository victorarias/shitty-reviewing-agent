# Composition Patterns

This guide covers patterns for combining tools, managing agent execution, and handling context across the agent lifecycle.

## The Agent Constructor

The `Agent` class accepts several configuration options that control composition:

```typescript
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, streamSimple } from "@mariozechner/pi-ai";

const agent = new Agent({
  // Initial state
  initialState: {
    systemPrompt: "...",
    model: getModel("anthropic", "claude-sonnet-4"),
    tools: [...],
    messages: [],
    thinkingLevel: "medium",
  },

  // Message transformation (required)
  convertToLlm: (messages) => {
    return messages.filter(m =>
      ["user", "assistant", "toolResult"].includes(m.role)
    );
  },

  // Context management (optional)
  transformContext: async (messages, signal) => {
    return pruneIfNeeded(messages);
  },

  // Steering injection (optional)
  getSteeringMessages: () => steeringQueue.drain(),
  steeringMode: "one-at-a-time",

  // Follow-up injection (optional)
  getFollowUpMessages: () => followUpQueue.drain(),
  followUpMode: "all",

  // API key resolution
  getApiKey: async (provider) => await getKey(provider),

  // Streaming function
  streamFn: (model, context, options) =>
    streamSimple(model, context, { ...options }),
});
```

## Tool Composition

### Layered Tool Sets

Organize tools into functional layers:

```typescript
function createAgentTools(config: AgentConfig): AgentTool<any>[] {
  // Layer 1: Read-only exploration
  const fsTools = createReadOnlyTools(config.rootPath);

  // Layer 2: Domain-specific information
  const githubTools = createGithubTools(config.octokit, config.pr);

  // Layer 3: Actions that affect state
  const reviewTools = createReviewTools(config.octokit, config.pr);

  // Layer 4: External capabilities (conditional)
  const searchTools = config.enableWebSearch
    ? [createWebSearchTool(config.apiKey)]
    : [];

  return [...fsTools, ...githubTools, ...reviewTools, ...searchTools];
}
```

### Conditional Tool Inclusion

Include tools based on context:

```typescript
function createTools(config: Config): AgentTool<any>[] {
  const tools: AgentTool<any>[] = [
    // Always include basic tools
    ...createFsTools(config.rootPath),
  ];

  // Include GitHub tools only if we have a PR context
  if (config.prNumber) {
    tools.push(...createGithubTools(config.octokit, config.pr));
  }

  // Include review tools only if not in read-only mode
  if (!config.readOnly) {
    tools.push(...createReviewTools(config.octokit, config.pr));
  }

  // Include web search only for supported providers
  if (config.provider === "google") {
    tools.push(createWebSearchTool(config.apiKey));
  }

  return tools;
}
```

### Tool Factories with Shared State

Create tools that share state through closures:

```typescript
interface ReviewState {
  commentsPosted: number;
  suggestionsPosted: number;
  summaryPosted: boolean;
  threadCache: Map<string, ThreadInfo[]>;
}

function createReviewToolsWithState(
  octokit: Octokit,
  pr: PullRequest,
): { tools: AgentTool<any>[]; state: ReviewState } {
  const state: ReviewState = {
    commentsPosted: 0,
    suggestionsPosted: 0,
    summaryPosted: false,
    threadCache: new Map(),
  };

  const onCommentPosted = () => {
    state.commentsPosted++;
  };

  const onSuggestionPosted = () => {
    state.suggestionsPosted++;
  };

  const getThreads = async (path: string, line: number) => {
    const key = `${path}:${line}`;
    if (!state.threadCache.has(key)) {
      state.threadCache.set(key, await fetchThreads(octokit, pr, path, line));
    }
    return state.threadCache.get(key)!;
  };

  return {
    tools: [
      createCommentTool(octokit, pr, getThreads, onCommentPosted),
      createSuggestTool(octokit, pr, getThreads, onSuggestionPosted),
      createPostSummaryTool(octokit, pr, state),
    ],
    state,
  };
}
```

## Context Management

### The transformContext Hook

Use `transformContext` to manage context before it reaches the LLM:

```typescript
const agent = new Agent({
  // ...
  transformContext: async (messages, signal) => {
    // Estimate token count
    const tokenCount = estimateTokens(messages);

    // If within limits, pass through
    if (tokenCount < MAX_CONTEXT_TOKENS * 0.8) {
      return messages;
    }

    // Prune old messages, keeping system context
    return pruneOldMessages(messages, MAX_CONTEXT_TOKENS);
  },
});
```

### Pruning Strategies

```typescript
function pruneOldMessages(
  messages: AgentMessage[],
  targetTokens: number,
): AgentMessage[] {
  const result: AgentMessage[] = [];
  let tokens = 0;

  // Always keep recent messages (reverse order)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const msgTokens = estimateTokens([msg]);

    if (tokens + msgTokens > targetTokens) {
      break;
    }

    result.unshift(msg);
    tokens += msgTokens;
  }

  // If we pruned, add a summary message
  if (result.length < messages.length) {
    const prunedCount = messages.length - result.length;
    result.unshift({
      role: "user",
      content: `[${prunedCount} earlier messages pruned for context limits]`,
      timestamp: Date.now(),
    });
  }

  return result;
}
```

### The convertToLlm Hook

Use `convertToLlm` to filter which messages the LLM sees:

```typescript
const agent = new Agent({
  // ...
  convertToLlm: (messages) => {
    return messages
      // Only include LLM-compatible message types
      .filter(m => ["user", "assistant", "toolResult"].includes(m.role))
      // Remove internal notification messages
      .filter(m => m.role !== "notification")
      // Convert custom messages if needed
      .map(m => {
        if (m.role === "summary") {
          return {
            role: "user",
            content: `[Previous conversation summary: ${m.text}]`,
            timestamp: m.timestamp,
          };
        }
        return m;
      });
  },
});
```

## Steering and Interruption

### Steering Messages

Steering messages interrupt the agent mid-execution:

```typescript
const steeringQueue: AgentMessage[] = [];

const agent = new Agent({
  // ...
  getSteeringMessages: () => {
    const messages = [...steeringQueue];
    steeringQueue.length = 0; // Clear queue
    return messages;
  },
  steeringMode: "one-at-a-time", // Inject one message per turn
});

// Later, to interrupt the agent:
function steerAgent(message: string) {
  steeringQueue.push({
    role: "user",
    content: message,
    timestamp: Date.now(),
  });
}

// Usage:
steerAgent("Stop reviewing and post a summary now.");
```

### When Steering Fires

Steering messages are checked:
- After each tool execution completes
- Before the next LLM call

If steering messages exist:
1. Remaining queued tools are skipped
2. Steering message is injected into context
3. LLM is called with the new context

### Steering Modes

- **"one-at-a-time"**: Inject one steering message per turn
- **"all"**: Inject all steering messages at once

```typescript
// One at a time: agent processes one steering message, then may continue
steeringMode: "one-at-a-time"

// All at once: agent receives all pending steering messages together
steeringMode: "all"
```

### Follow-up Messages

Follow-up messages are injected after the agent has no more tool calls:

```typescript
const followUpQueue: AgentMessage[] = [];

const agent = new Agent({
  // ...
  getFollowUpMessages: () => {
    const messages = [...followUpQueue];
    followUpQueue.length = 0;
    return messages;
  },
  followUpMode: "all",
});

// Add follow-up after initial task
function queueFollowUp(message: string) {
  followUpQueue.push({
    role: "user",
    content: message,
    timestamp: Date.now(),
  });
}
```

### Steering vs Follow-up

| Aspect | Steering | Follow-up |
|--------|----------|-----------|
| **When** | After each tool execution | After agent stops making tool calls |
| **Purpose** | Interrupt/redirect mid-task | Continue after completion |
| **Effect** | Skips remaining queued tools | Starts new agent turn |
| **Use case** | "Stop now", "Change approach" | "Now do X", "Continue with Y" |

## Event-Driven Composition

### Subscribing to Events

Monitor agent execution through events:

```typescript
const agent = new Agent({ /* ... */ });

agent.subscribe((event) => {
  switch (event.type) {
    case "agent_start":
      console.log("Agent started");
      break;

    case "tool_execution_start":
      console.log(`Calling ${event.toolName}...`);
      break;

    case "tool_execution_end":
      if (event.isError) {
        console.error(`${event.toolName} failed:`, event.result);
      }
      break;

    case "message_end":
      if (event.message.role === "assistant") {
        trackUsage(event.message.usage);
      }
      break;

    case "agent_end":
      console.log("Agent finished");
      break;
  }
});
```

### Event-Based Control Flow

Use events to control agent behavior:

```typescript
let toolExecutions = 0;
const MAX_TOOL_EXECUTIONS = 100;

agent.subscribe((event) => {
  if (event.type === "tool_execution_end") {
    toolExecutions++;

    // Abort if too many tool calls
    if (toolExecutions >= MAX_TOOL_EXECUTIONS) {
      console.warn("Tool execution limit reached, aborting");
      agent.abort();
    }
  }
});
```

### Preventing Post-Summary Actions

```typescript
let summaryPosted = false;

agent.subscribe((event) => {
  // Track when summary is posted
  if (event.type === "tool_execution_end" && event.toolName === "post_summary") {
    summaryPosted = true;
  }

  // Abort if tools are called after summary
  if (event.type === "tool_execution_start" && summaryPosted) {
    console.warn("Tool called after summary, aborting");
    agent.abort();
  }
});
```

## Error Handling Patterns

### Retry with Backoff

```typescript
async function runWithRetry(
  agent: Agent,
  prompt: string,
  maxRetries: number = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await agent.prompt(prompt);
      return; // Success
    } catch (error) {
      if (isRetryableError(error) && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
        console.warn(`Attempt ${attempt} failed, retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      throw error; // Give up
    }
  }
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.message.includes("rate limit") ||
      error.message.includes("timeout") ||
      error.message.includes("503") ||
      error.message.includes("529")
    );
  }
  return false;
}
```

### Graceful Degradation

```typescript
async function runReview(config: ReviewConfig): Promise<ReviewResult> {
  const { tools, state } = createReviewToolsWithState(config.octokit, config.pr);

  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(),
      model: config.model,
      tools,
      messages: [],
    },
    // ...
  });

  try {
    await agent.prompt(buildUserPrompt(config));

    return {
      verdict: state.summaryPosted ? "completed" : "incomplete",
      comments: state.commentsPosted,
      suggestions: state.suggestionsPosted,
    };
  } catch (error) {
    // Graceful degradation: post failure summary
    if (!state.summaryPosted) {
      await postFailureSummary(config.octokit, config.pr, error);
    }

    return {
      verdict: "failed",
      error: error.message,
      comments: state.commentsPosted,
      suggestions: state.suggestionsPosted,
    };
  }
}
```

## Multi-Agent Patterns

### Sequential Agents

Run agents in sequence, passing context:

```typescript
async function analyzeAndReview(pr: PullRequest): Promise<void> {
  // Phase 1: Analysis agent
  const analysisAgent = createAnalysisAgent();
  await analysisAgent.prompt(`Analyze PR #${pr.number} and identify risk areas.`);
  const analysis = extractAnalysis(analysisAgent.state.messages);

  // Phase 2: Review agent with analysis context
  const reviewAgent = createReviewAgent();
  await reviewAgent.prompt(
    `Review PR #${pr.number}.\n\nPrior analysis identified these risk areas:\n${analysis}`
  );
}
```

### Parallel Tool Execution

The agent naturally parallelizes independent tool calls. To encourage parallelism, mention it in the system prompt:

```typescript
const systemPrompt = `
When you need to gather information from multiple files, you can call
read multiple times in the same response. The tools will execute in parallel.

Example: To read both config.ts and utils.ts, call read("config.ts") and
read("utils.ts") in the same response.
`;
```

### Delegation Pattern

Have one agent delegate to specialized sub-agents:

```typescript
const delegatorTool: AgentTool<typeof DelegateParams> = {
  name: "delegate",
  description: "Delegates a sub-task to a specialized agent",
  parameters: Type.Object({
    task: Type.Union([
      Type.Literal("security_review"),
      Type.Literal("performance_review"),
      Type.Literal("test_coverage"),
    ]),
    files: Type.Array(Type.String()),
  }),
  execute: async (toolCallId, { task, files }) => {
    const subAgent = createSpecializedAgent(task);
    await subAgent.prompt(`Review these files for ${task}: ${files.join(", ")}`);

    const findings = extractFindings(subAgent.state.messages);
    return {
      content: [{
        type: "text",
        text: `${task} findings:\n${findings}`,
      }],
    };
  },
};
```

## State Management

### Tracking Across Tool Calls

```typescript
interface ReviewState {
  filesReviewed: Set<string>;
  issuesFound: Issue[];
  summaryPosted: boolean;
}

function createReviewTools(
  initialState: Partial<ReviewState> = {},
): { tools: AgentTool<any>[]; getState: () => ReviewState } {
  const state: ReviewState = {
    filesReviewed: new Set(initialState.filesReviewed || []),
    issuesFound: [...(initialState.issuesFound || [])],
    summaryPosted: initialState.summaryPosted || false,
  };

  const tools = [
    {
      name: "mark_reviewed",
      execute: async (id, { path }) => {
        state.filesReviewed.add(path);
        return { content: [{ type: "text", text: `Marked ${path} as reviewed.` }] };
      },
    },
    {
      name: "record_issue",
      execute: async (id, issue) => {
        state.issuesFound.push(issue);
        return { content: [{ type: "text", text: "Issue recorded." }] };
      },
    },
    {
      name: "get_progress",
      execute: async () => {
        return {
          content: [{
            type: "text",
            text: `Reviewed: ${state.filesReviewed.size} files, Found: ${state.issuesFound.length} issues`,
          }],
        };
      },
    },
  ];

  return { tools, getState: () => ({ ...state }) };
}
```

### Persistence Across Sessions

```typescript
async function runIncrementalReview(pr: PullRequest): Promise<void> {
  // Load previous state
  const previousState = await loadReviewState(pr.number);

  // Create tools with previous state
  const { tools, getState } = createReviewTools(previousState);

  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(),
      model: getModel("anthropic", "claude-sonnet-4"),
      tools,
      messages: previousState.messages || [],
    },
  });

  // Resume from where we left off
  if (previousState.lastPrompt) {
    await agent.continue();
  } else {
    await agent.prompt(buildUserPrompt(pr));
  }

  // Save state for next run
  await saveReviewState(pr.number, {
    ...getState(),
    messages: agent.state.messages,
  });
}
```

## Summary

1. **Layer tools by function**: Exploration → Information → Actions → External
2. **Use closures for shared state**: Tool factories enable coordination
3. **Transform context strategically**: Prune, summarize, inject as needed
4. **Steer for interruption**: Use steering messages to redirect mid-task
5. **Follow up for continuation**: Use follow-up messages for multi-phase tasks
6. **Monitor through events**: Track execution, enforce limits, detect completion
7. **Handle errors gracefully**: Retry transient failures, degrade on permanent ones
8. **Track state explicitly**: Don't rely on message history alone
