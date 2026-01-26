# Testing and Iteration

Agent behavior is emergent—it results from prompts, tools, and model capabilities interacting. Testing agents requires different approaches than testing deterministic code. This guide covers strategies for validating and refining agent behavior.

## Testing Philosophy

### Test Behavior, Not Implementation

Focus on what the agent does, not how it decides to do it:

```typescript
// Bad: Testing internal decision-making
test("agent decides to read file before commenting", () => {
  // This tests implementation, not behavior
});

// Good: Testing observable behavior
test("comment tool requires file to have been read", async () => {
  const result = await commentTool.execute("call-1", {
    path: "unread.ts",
    line: 10,
    body: "Comment",
  });

  expect(result.content[0].text).toContain("read the file first");
});
```

### Test Tools Independently

Tools are deterministic—test them thoroughly:

```typescript
import { test, expect, describe } from "bun:test";

describe("comment tool", () => {
  test("posts new comment when no existing threads", async () => {
    const { tools, mockOctokit } = createTestTools({ existingThreads: [] });
    const commentTool = tools.find(t => t.name === "comment")!;

    await commentTool.execute("call-1", {
      path: "test.ts",
      line: 10,
      body: "New comment",
    });

    expect(mockOctokit.calls).toHaveLength(1);
    expect(mockOctokit.calls[0].method).toBe("createReviewComment");
  });

  test("replies to existing thread when thread_id provided", async () => {
    const { tools, mockOctokit } = createTestTools({
      existingThreads: [{ id: 123, path: "test.ts", line: 10 }],
    });
    const commentTool = tools.find(t => t.name === "comment")!;

    await commentTool.execute("call-1", {
      path: "test.ts",
      line: 10,
      body: "Reply",
      thread_id: 123,
    });

    expect(mockOctokit.calls).toHaveLength(1);
    expect(mockOctokit.calls[0].method).toBe("createReplyForReviewComment");
    expect(mockOctokit.calls[0].args.comment_id).toBe(123);
  });

  test("returns error when multiple threads exist without thread_id", async () => {
    const { tools, mockOctokit } = createTestTools({
      existingThreads: [
        { id: 1, path: "test.ts", line: 10, side: "RIGHT" },
        { id: 2, path: "test.ts", line: 10, side: "RIGHT" },
      ],
    });
    const commentTool = tools.find(t => t.name === "comment")!;

    const result = await commentTool.execute("call-1", {
      path: "test.ts",
      line: 10,
      body: "Comment",
    });

    // Should not have posted
    expect(mockOctokit.calls).toHaveLength(0);

    // Should explain the ambiguity
    expect(result.content[0].text).toContain("Multiple threads exist");
    expect(result.content[0].text).toContain("thread_id");
  });
});
```

### Test Edge Cases Exhaustively

```typescript
describe("read tool", () => {
  test("handles non-existent file", async () => {
    const result = await readTool.execute("call-1", { path: "missing.ts" });
    expect(result.content[0].text).toContain("not found");
  });

  test("handles binary file", async () => {
    const result = await readTool.execute("call-1", { path: "image.png" });
    expect(result.content[0].text).toContain("binary");
  });

  test("truncates large files", async () => {
    const result = await readTool.execute("call-1", {
      path: "huge.ts",
      max_chars: 1000,
    });
    expect(result.content[0].text.length).toBeLessThanOrEqual(1000);
    expect(result.content[0].text).toContain("truncated");
  });

  test("prevents path traversal", async () => {
    await expect(
      readTool.execute("call-1", { path: "../../../etc/passwd" })
    ).rejects.toThrow("outside allowed root");
  });

  test("handles empty file", async () => {
    const result = await readTool.execute("call-1", { path: "empty.ts" });
    expect(result.content[0].text).toBe("");
  });
});
```

## Integration Testing

### Smoke Tests

Run the full agent against real (or realistic) inputs:

```typescript
// scripts/smoke.mjs
import { runReview } from "../src/agent.js";

const config = {
  provider: process.env.PROVIDER || "openrouter",
  apiKey: process.env.API_KEY,
  model: process.env.MODEL || "anthropic/claude-sonnet-4",
  repo: process.env.REPO,
  prNumber: parseInt(process.env.PR_NUMBER),
  token: process.env.GITHUB_TOKEN,
};

const result = await runReview(config);

console.log("Result:", result);

// Basic assertions
if (!result.summaryPosted) {
  console.error("FAIL: Summary was not posted");
  process.exit(1);
}

console.log("PASS: Smoke test completed");
```

### Recording and Replay

Record agent sessions for reproducible testing:

```typescript
interface RecordedSession {
  config: AgentConfig;
  messages: AgentMessage[];
  toolCalls: ToolCall[];
  finalState: any;
}

async function recordSession(agent: Agent, prompt: string): Promise<RecordedSession> {
  const toolCalls: ToolCall[] = [];

  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      toolCalls.push({
        name: event.toolName,
        args: event.args,
        timestamp: Date.now(),
      });
    }
  });

  await agent.prompt(prompt);

  return {
    config: extractConfig(agent),
    messages: [...agent.state.messages],
    toolCalls,
    finalState: extractFinalState(agent),
  };
}

// Save for later analysis
await writeFile("session.json", JSON.stringify(session, null, 2));
```

### Behavioral Assertions

Assert on session recordings:

```typescript
test("agent reviews all changed files", async () => {
  const session = await recordSession(agent, userPrompt);

  const changedFiles = ["src/index.ts", "src/utils.ts", "README.md"];
  const readCalls = session.toolCalls.filter(c => c.name === "read");
  const readPaths = readCalls.map(c => c.args.path);

  for (const file of changedFiles) {
    expect(readPaths).toContain(file);
  }
});

test("agent posts summary as final action", async () => {
  const session = await recordSession(agent, userPrompt);

  const lastToolCall = session.toolCalls[session.toolCalls.length - 1];
  expect(lastToolCall.name).toBe("post_summary");

  // No tool calls after summary
  const summaryIndex = session.toolCalls.findIndex(c => c.name === "post_summary");
  expect(summaryIndex).toBe(session.toolCalls.length - 1);
});
```

## Iteration Strategies

### Observe First

Before changing anything, observe current behavior:

```typescript
async function observeAgent(agent: Agent, prompt: string): Promise<void> {
  agent.subscribe((event) => {
    switch (event.type) {
      case "tool_execution_start":
        console.log(`→ ${event.toolName}(${JSON.stringify(event.args)})`);
        break;
      case "tool_execution_end":
        console.log(`← ${event.toolName}: ${event.isError ? "ERROR" : "OK"}`);
        break;
      case "message_end":
        if (event.message.role === "assistant") {
          const text = event.message.content.find(c => c.type === "text");
          if (text) {
            console.log(`Agent: ${text.text.slice(0, 200)}...`);
          }
        }
        break;
    }
  });

  await agent.prompt(prompt);
}
```

### Identify Divergence Points

When behavior diverges from expectations, find where:

```typescript
async function findDivergence(
  agent: Agent,
  prompt: string,
  expected: ExpectedBehavior,
): Promise<DivergencePoint | null> {
  const events: AgentEvent[] = [];

  agent.subscribe((event) => events.push(event));
  await agent.prompt(prompt);

  for (let i = 0; i < expected.toolCalls.length; i++) {
    const expectedCall = expected.toolCalls[i];
    const actualCall = events.find(
      (e, j) => e.type === "tool_execution_start" && j >= i
    );

    if (!actualCall || actualCall.toolName !== expectedCall.name) {
      return {
        index: i,
        expected: expectedCall,
        actual: actualCall || null,
        context: events.slice(Math.max(0, i - 5), i + 5),
      };
    }
  }

  return null;
}
```

### Incremental Prompt Refinement

Refine prompts based on observed divergence:

```typescript
// Version 1: Initial prompt
const v1 = "Review the PR and post comments.";

// Observation: Agent doesn't check existing threads
// Version 2: Add explicit instruction
const v2 = "Review the PR. Check existing threads before posting new comments.";

// Observation: Agent still creates duplicate comments
// Version 3: Make it a hard rule
const v3 = `
Review the PR.
RULE: Before posting a comment, call list_threads_for_location to check for existing threads.
If threads exist, reply to the most recent one instead of creating a new comment.
`;

// Observation: Works, but agent sometimes misses the most recent
// Version 4: Be more specific about "most recent"
const v4 = `
Review the PR.
RULE: Before posting a comment:
1. Call list_threads_for_location(path, line)
2. If threads exist, find the one with the most recent last_activity timestamp
3. Reply to that thread using thread_id
4. Only create a new comment if no threads exist
`;
```

### A/B Testing Prompts

Compare different prompt versions:

```typescript
interface PromptVariant {
  name: string;
  prompt: string;
}

async function compareVariants(
  variants: PromptVariant[],
  testCases: TestCase[],
): Promise<ComparisonResult[]> {
  const results: ComparisonResult[] = [];

  for (const testCase of testCases) {
    for (const variant of variants) {
      const agent = createAgent(variant.prompt);
      const session = await recordSession(agent, testCase.input);

      results.push({
        variant: variant.name,
        testCase: testCase.name,
        success: evaluateSession(session, testCase.expected),
        toolCalls: session.toolCalls.length,
        tokens: calculateTokens(session),
      });
    }
  }

  return results;
}

// Analyze results
const summary = results.reduce((acc, r) => {
  if (!acc[r.variant]) {
    acc[r.variant] = { successes: 0, total: 0, avgToolCalls: 0 };
  }
  acc[r.variant].total++;
  if (r.success) acc[r.variant].successes++;
  acc[r.variant].avgToolCalls += r.toolCalls;
  return acc;
}, {});
```

## Debugging Techniques

### Verbose Logging

```typescript
function createVerboseAgent(config: AgentConfig): Agent {
  const agent = new Agent(config);

  agent.subscribe((event) => {
    const timestamp = new Date().toISOString();

    switch (event.type) {
      case "agent_start":
        console.log(`[${timestamp}] === AGENT START ===`);
        break;

      case "tool_execution_start":
        console.log(`[${timestamp}] TOOL START: ${event.toolName}`);
        console.log(`  Args: ${JSON.stringify(event.args, null, 2)}`);
        break;

      case "tool_execution_end":
        console.log(`[${timestamp}] TOOL END: ${event.toolName}`);
        console.log(`  Error: ${event.isError}`);
        console.log(`  Result: ${JSON.stringify(event.result).slice(0, 500)}`);
        break;

      case "message_end":
        if (event.message.role === "assistant") {
          console.log(`[${timestamp}] ASSISTANT MESSAGE:`);
          for (const content of event.message.content) {
            if (content.type === "text") {
              console.log(`  Text: ${content.text.slice(0, 500)}`);
            } else if (content.type === "thinking") {
              console.log(`  Thinking: ${content.text.slice(0, 500)}`);
            } else if (content.type === "tool_use") {
              console.log(`  Tool use: ${content.name}`);
            }
          }
        }
        break;

      case "agent_end":
        console.log(`[${timestamp}] === AGENT END ===`);
        break;
    }
  });

  return agent;
}
```

### Thinking Extraction

When using extended thinking, extract and analyze reasoning:

```typescript
function extractThinking(messages: AgentMessage[]): string[] {
  const thinking: string[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const content of msg.content) {
        if (content.type === "thinking") {
          thinking.push(content.text);
        }
      }
    }
  }

  return thinking;
}

// After agent run
const thinking = extractThinking(agent.state.messages);
console.log("Agent reasoning:");
thinking.forEach((t, i) => console.log(`Step ${i + 1}:`, t));
```

### Error Analysis

Analyze errors from failed runs:

```typescript
interface ErrorAnalysis {
  errorType: string;
  message: string;
  toolContext: ToolCall | null;
  messageContext: AgentMessage[];
  suggestions: string[];
}

function analyzeError(
  error: Error,
  events: AgentEvent[],
): ErrorAnalysis {
  const lastToolCall = events
    .filter(e => e.type === "tool_execution_start")
    .pop();

  const recentMessages = events
    .filter(e => e.type === "message_end")
    .slice(-3)
    .map(e => e.message);

  const suggestions: string[] = [];

  if (error.message.includes("rate limit")) {
    suggestions.push("Add retry logic with exponential backoff");
    suggestions.push("Reduce parallel tool calls");
  }

  if (error.message.includes("context length")) {
    suggestions.push("Enable transformContext to prune old messages");
    suggestions.push("Reduce file read sizes");
  }

  if (error.message.includes("timeout")) {
    suggestions.push("Increase timeout for slow operations");
    suggestions.push("Break large operations into smaller chunks");
  }

  return {
    errorType: error.name,
    message: error.message,
    toolContext: lastToolCall || null,
    messageContext: recentMessages,
    suggestions,
  };
}
```

## Test Fixtures

### Mock Octokit

```typescript
function createMockOctokit(): MockOctokit {
  const calls: OctokitCall[] = [];

  return {
    calls,
    rest: {
      pulls: {
        listFiles: async () => {
          calls.push({ method: "listFiles" });
          return { data: mockChangedFiles };
        },
        get: async () => {
          calls.push({ method: "getPull" });
          return { data: mockPullRequest };
        },
        createReviewComment: async (args) => {
          calls.push({ method: "createReviewComment", args });
          return { data: { id: Date.now() } };
        },
        createReplyForReviewComment: async (args) => {
          calls.push({ method: "createReplyForReviewComment", args });
          return { data: { id: Date.now() } };
        },
      },
      issues: {
        createComment: async (args) => {
          calls.push({ method: "createIssueComment", args });
          return { data: { id: Date.now() } };
        },
      },
    },
  };
}
```

### Test Data Factories

```typescript
function createTestThread(overrides: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: Math.floor(Math.random() * 10000),
    path: "test.ts",
    line: 10,
    side: "RIGHT",
    comments: 1,
    lastActivity: new Date().toISOString(),
    ...overrides,
  };
}

function createTestPullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 123,
    title: "Test PR",
    body: "Test description",
    author: "testuser",
    base: { ref: "main", sha: "abc123" },
    head: { ref: "feature", sha: "def456" },
    url: "https://github.com/owner/repo/pull/123",
    ...overrides,
  };
}
```

## Continuous Validation

### Regression Tests

When you fix a behavior, add a regression test:

```typescript
// After fixing: "agent was creating duplicate comments"
test("regression: no duplicate comments at same location", async () => {
  const { tools, mockOctokit } = createTestTools({
    existingThreads: [{ id: 1, path: "test.ts", line: 10 }],
  });

  const agent = createAgent(tools);
  await agent.prompt("Review test.ts and comment on line 10");

  // Should reply to existing, not create new
  const newComments = mockOctokit.calls.filter(
    c => c.method === "createReviewComment"
  );
  expect(newComments).toHaveLength(0);

  const replies = mockOctokit.calls.filter(
    c => c.method === "createReplyForReviewComment"
  );
  expect(replies.length).toBeGreaterThan(0);
});
```

### Golden Tests

Compare output against known-good results:

```typescript
test("golden: standard review output format", async () => {
  const session = await recordSession(agent, standardTestPrompt);

  // Compare against golden file
  const golden = JSON.parse(await readFile("tests/golden/standard-review.json"));

  // Tool sequence should match
  expect(session.toolCalls.map(c => c.name)).toEqual(
    golden.toolCalls.map(c => c.name)
  );

  // Summary format should match pattern
  const summary = extractSummary(session);
  expect(summary).toMatch(golden.summaryPattern);
});
```

## Summary

1. **Test tools, not agents**: Tools are deterministic; test them thoroughly
2. **Test behavior, not implementation**: Focus on observable outcomes
3. **Record sessions**: Capture runs for analysis and regression testing
4. **Observe before changing**: Understand current behavior before modifying
5. **Iterate incrementally**: Small prompt changes, test, repeat
6. **Extract thinking**: Use extended thinking to understand agent reasoning
7. **Analyze errors**: Build debugging tools to understand failures
8. **Prevent regression**: Add tests when fixing behaviors
