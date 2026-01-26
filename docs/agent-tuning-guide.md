# Agent Tuning Guide

A comprehensive guide to tuning LLM agents using the pi-agent-core and pi-ai libraries. This guide covers prompt engineering, tool design, behavior steering, and model-specific optimization.

## Philosophy

**Tools-first approach**: Give frontier models rich context and precise tools, then let them decide how to behave. Prefer explicit choices over hard-coded heuristics.

This philosophy has three core implications:

1. **Don't fight the model** - Work with its natural capabilities rather than forcing specific patterns
2. **Make choices explicit** - Surface ambiguity and require the agent to pick rather than auto-resolving
3. **Steer through design** - Use tool design and prompt structure to guide behavior, not rigid rules

## Quick Reference

| Aspect | Primary Mechanism | See Guide |
|--------|------------------|-----------|
| Define role/persona | System prompt | [Prompt Engineering](./prompt-engineering.md) |
| Control workflow | Tool design + system prompt | [Tool Design](./tool-design.md) |
| Handle edge cases | Tool return values | [Tool Design](./tool-design.md) |
| Manage context | `transformContext` callback | [Composition](./composition-patterns.md) |
| Interrupt execution | Steering messages | [Composition](./composition-patterns.md) |
| Adapt to models | Provider detection + config | [Model Tuning](./model-specific-tuning.md) |

## The Tuning Hierarchy

Agent behavior emerges from multiple layers, each with different leverage:

```
┌─────────────────────────────────────────┐
│          1. MODEL SELECTION             │  ← Highest leverage
│   (capabilities, reasoning, cost)        │
├─────────────────────────────────────────┤
│          2. SYSTEM PROMPT               │
│   (role, constraints, workflow)          │
├─────────────────────────────────────────┤
│          3. TOOL DESIGN                 │
│   (what agent can do, how it learns)     │
├─────────────────────────────────────────┤
│          4. USER PROMPT                 │
│   (context, task, dynamic state)         │
├─────────────────────────────────────────┤
│          5. RUNTIME STEERING            │  ← Lowest leverage
│   (interruption, follow-up)              │
└─────────────────────────────────────────┘
```

Changes at higher levels have broader impact. Start tuning from the top.

## Core Concepts

### 1. The Agent Loop

The pi-agent-core library implements a simple but powerful loop:

```
prompt(userMessage)
    ↓
┌──────────────────┐
│  LLM generates   │◄────────────────┐
│  response        │                 │
└────────┬─────────┘                 │
         │                           │
         ▼                           │
    ┌────────────┐                   │
    │ Tool calls?│──── yes ──►Execute tools
    └─────┬──────┘              │    │
          │                     │    │
          no                    │    │
          │                     ▼    │
          ▼              ┌──────────┐│
    ┌──────────┐         │  Add     ││
    │  Done    │         │  results ├┘
    └──────────┘         │  to ctx  │
                         └──────────┘
```

The agent continues until the LLM generates a response with no tool calls.

### 2. State vs. Behavior

**State** is what the agent knows:
- System prompt
- Message history
- Available tools
- Current model

**Behavior** emerges from state interacting with the model:
- How it interprets tasks
- Which tools it chooses
- How it handles errors
- When it decides to stop

You tune behavior by shaping state.

### 3. Explicit vs. Implicit Control

**Implicit control** - hoping the model figures it out:
```typescript
// Bad: implicit, model may or may not follow
const systemPrompt = "Review code carefully and be helpful";
```

**Explicit control** - clear constraints and requirements:
```typescript
// Good: explicit workflow and termination
const systemPrompt = `
You review PRs. Your workflow:
1. Call get_pr_info to understand the PR
2. Call get_changed_files to see what changed
3. Review each file using get_diff and read
4. Post comments using comment or suggest
5. Call post_summary exactly once as your final action, then stop

You MUST call post_summary. Do not continue after calling it.
`;
```

## Getting Started

### Basic Agent Setup

```typescript
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, streamSimple } from "@mariozechner/pi-ai";

const agent = new Agent({
  initialState: {
    systemPrompt: "You are a helpful assistant.",
    model: getModel("anthropic", "claude-sonnet-4"),
    tools: [],
    messages: [],
  },
  streamFn: (model, context, options) =>
    streamSimple(model, context, { ...options, apiKey: process.env.ANTHROPIC_API_KEY }),
});

// Run the agent
await agent.prompt("Hello, world!");
```

### Adding Tools

```typescript
import { Type } from "@sinclair/typebox";

const readFileTool = {
  name: "read_file",
  label: "Read File",
  description: "Reads the contents of a file at the given path",
  parameters: Type.Object({
    path: Type.String({ description: "Path to the file" }),
  }),
  execute: async (toolCallId, { path }) => {
    const content = await fs.readFile(path, "utf-8");
    return { content: [{ type: "text" as const, text: content }] };
  },
};

const agent = new Agent({
  initialState: {
    systemPrompt: "You can read files using the read_file tool.",
    model: getModel("anthropic", "claude-sonnet-4"),
    tools: [readFileTool],
    messages: [],
  },
  streamFn: yourStreamFn,
});
```

### Monitoring Events

```typescript
agent.subscribe((event) => {
  switch (event.type) {
    case "tool_execution_start":
      console.log(`Calling ${event.toolName}...`);
      break;
    case "tool_execution_end":
      console.log(`${event.toolName} ${event.isError ? "failed" : "succeeded"}`);
      break;
    case "message_end":
      // Track token usage
      if (event.message.role === "assistant") {
        console.log(`Tokens: ${event.message.usage.totalTokens}`);
      }
      break;
  }
});
```

## Documents in This Guide

1. **[Prompt Engineering](./prompt-engineering.md)** - Crafting system and user prompts that shape behavior
2. **[Tool Design](./tool-design.md)** - Building tools that guide agent decisions
3. **[Composition Patterns](./composition-patterns.md)** - Combining tools, steering, and context management
4. **[Model-Specific Tuning](./model-specific-tuning.md)** - Adapting to different LLM providers
5. **[Testing & Iteration](./testing-and-iteration.md)** - Validating and refining agent behavior

## Key Takeaways

1. **Prompt explicitly** - State workflows, constraints, and termination conditions clearly
2. **Design tools that teach** - Tool responses should guide the agent toward correct behavior
3. **Surface ambiguity** - Make the agent choose explicitly rather than auto-resolving
4. **Test behavior** - Focus on outcomes, not implementation details
5. **Iterate on real tasks** - Theory matters less than observation
