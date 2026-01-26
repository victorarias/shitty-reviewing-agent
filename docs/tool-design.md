# Tool Design for Agent Steering

Tools are how agents interact with the world. Well-designed tools don't just execute actions—they teach the agent how to behave correctly. This guide covers tool design patterns that steer agent behavior.

## Tool Anatomy

Every tool in pi-agent-core has these components:

```typescript
import { Type, Static } from "@sinclair/typebox";
import { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const myTool: AgentTool<typeof MyParams> = {
  name: "my_tool",           // Identifier the LLM uses
  label: "My Tool",          // Human-readable label
  description: "...",        // Crucial: teaches LLM when/how to use it
  parameters: MyParams,      // TypeBox schema
  execute: async (toolCallId, params, signal, onUpdate) => {
    // Do the work
    return { content: [{ type: "text", text: "result" }] };
  },
};

const MyParams = Type.Object({
  required_param: Type.String({ description: "What this param is for" }),
  optional_param: Type.Optional(Type.String({ description: "..." })),
});
```

## The Description is Everything

The tool description is your primary lever for steering behavior. The LLM reads this to decide:
1. Whether to use the tool
2. What parameters to provide
3. How to interpret the result

### Description Patterns

**Purpose + When to Use**:
```typescript
description: `
Reads the contents of a file at the given path.
Use this to see full file context, not just diffs.
Prefer reading before commenting on code you haven't seen.
`
```

**Parameter Guidance**:
```typescript
description: `
Posts an inline comment on a specific line of code.

Parameters:
- path: The file path
- line: The line number to comment on
- body: The comment text

If multiple review threads exist at this location, you must specify
thread_id to reply to an existing thread, or set allow_new_thread=true
to create a new one.
`
```

**Output Format**:
```typescript
description: `
Returns PR information including title, body, author, and refs.

Returns:
{
  title: string,
  body: string,
  author: string,
  base: { ref: string, sha: string },
  head: { ref: string, sha: string },
  url: string
}
`
```

**Negative Guidance**:
```typescript
description: `
Searches for files matching a glob pattern.

Do NOT use this for searching file contents - use grep for that.
Do NOT include node_modules or .git in results.
`
```

## Parameter Design

### Use TypeBox for Schemas

TypeBox provides type-safe JSON schemas:

```typescript
import { Type } from "@sinclair/typebox";

const CommentParams = Type.Object({
  path: Type.String({
    description: "Path to the file being commented on",
  }),
  line: Type.Number({
    description: "Line number to attach the comment to",
  }),
  body: Type.String({
    description: "The comment text. Be specific and actionable.",
  }),
  side: Type.Optional(Type.Union([
    Type.Literal("LEFT"),
    Type.Literal("RIGHT"),
  ], {
    description: "Which side of the diff: LEFT (old) or RIGHT (new). Defaults to RIGHT.",
  })),
  thread_id: Type.Optional(Type.Number({
    description: "If replying to an existing thread, the root comment ID",
  })),
});
```

### Parameter Descriptions Matter

The LLM sees parameter descriptions. Use them to guide behavior:

```typescript
// Bad: No guidance
line: Type.Number()

// Good: Clear purpose
line: Type.Number({
  description: "The line number to comment on. Use the line number from the diff, not the absolute file line.",
})

// Better: With constraints
line: Type.Number({
  description: "Line number from the diff (1-indexed). Must be within the changed region.",
  minimum: 1,
})
```

### Optional vs Required Parameters

Make parameters optional when there's a sensible default, but describe what happens:

```typescript
const ReadParams = Type.Object({
  path: Type.String({
    description: "Path to the file",
  }),
  start_line: Type.Optional(Type.Number({
    description: "First line to read (1-indexed). Defaults to 1.",
  })),
  end_line: Type.Optional(Type.Number({
    description: "Last line to read (inclusive). Defaults to end of file.",
  })),
  max_chars: Type.Optional(Type.Number({
    description: "Maximum characters to return. Defaults to 20000. Truncates if exceeded.",
  })),
});
```

## Return Values as Teaching Moments

Tool return values guide the agent's next action. Use them to:

### 1. Report Success with Context

```typescript
execute: async (toolCallId, { path, line, body }) => {
  await postComment(path, line, body);
  return {
    content: [{
      type: "text",
      text: `Comment posted successfully on ${path}:${line}`,
    }],
  };
}
```

### 2. Surface Errors Informatively

```typescript
execute: async (toolCallId, { path }) => {
  try {
    const content = await fs.readFile(path, "utf-8");
    return { content: [{ type: "text", text: content }] };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        content: [{
          type: "text",
          text: `File not found: ${path}. Use find() to search for files.`,
        }],
      };
    }
    throw error; // Let framework handle unexpected errors
  }
}
```

### 3. Guide on Ambiguity

This is the key pattern for steering behavior. When the situation is ambiguous, don't auto-resolve—tell the agent what choices exist:

```typescript
execute: async (toolCallId, { path, line, body, thread_id, side }) => {
  const threads = await getThreadsAtLocation(path, line);

  // Ambiguity: multiple threads exist but none specified
  if (threads.length > 1 && !thread_id) {
    const threadList = threads.map(t =>
      `- thread_id=${t.id} (${t.side}, ${t.comments} comments, last active: ${t.lastActivity})`
    ).join("\n");

    return {
      content: [{
        type: "text",
        text: `Multiple threads exist at ${path}:${line}:\n${threadList}\n\n` +
              `Please specify thread_id to reply to one, or set allow_new_thread=true to create a new thread.`,
      }],
    };
  }

  // Unambiguous: proceed with action
  await postComment(path, line, body, thread_id);
  return { content: [{ type: "text", text: "Comment posted." }] };
}
```

### 4. Provide Next Steps

```typescript
execute: async (toolCallId, params) => {
  const result = await doSearch(params);

  if (result.length === 0) {
    return {
      content: [{
        type: "text",
        text: "No results found. Try:\n" +
              "- Broadening your search pattern\n" +
              "- Checking a different directory\n" +
              "- Using grep for content search instead of find for file names",
      }],
    };
  }

  return {
    content: [{
      type: "text",
      text: `Found ${result.length} files:\n${result.join("\n")}`,
    }],
  };
}
```

## Design Patterns

### The Gatekeeper Pattern

Tools that guard against incorrect usage:

```typescript
const commentTool: AgentTool<typeof CommentParams> = {
  name: "comment",
  description: "Posts a comment. Checks for existing threads first.",
  parameters: CommentParams,
  execute: async (toolCallId, params) => {
    // Gate 1: Check for existing threads
    const threads = await getThreadsAtLocation(params.path, params.line);
    if (threads.length > 0 && !params.thread_id && !params.allow_new_thread) {
      return {
        content: [{
          type: "text",
          text: `Thread already exists at this location. ` +
                `Use thread_id=${threads[0].id} to reply, ` +
                `or set allow_new_thread=true to create a new thread.`,
        }],
      };
    }

    // Gate 2: Validate the line is in the diff
    const diff = await getDiff(params.path);
    if (!lineIsInDiff(diff, params.line)) {
      return {
        content: [{
          type: "text",
          text: `Line ${params.line} is not in the diff for ${params.path}. ` +
                `Only lines that appear in the diff can receive comments.`,
        }],
      };
    }

    // All gates passed
    await postComment(params);
    return { content: [{ type: "text", text: "Comment posted." }] };
  },
};
```

### The Discovery Pattern

Tools that help the agent discover what's available:

```typescript
const listThreadsTool: AgentTool<typeof ListThreadsParams> = {
  name: "list_threads_for_location",
  description: `
Lists existing review threads at a specific file/line location.
Use this when you need to know what threads exist before commenting.

Returns thread IDs, sides (LEFT/RIGHT), comment counts, and activity timestamps.
`,
  parameters: Type.Object({
    path: Type.String({ description: "File path" }),
    line: Type.Number({ description: "Line number" }),
    side: Type.Optional(Type.Union([
      Type.Literal("LEFT"),
      Type.Literal("RIGHT"),
    ], { description: "Filter to specific side" })),
  }),
  execute: async (toolCallId, { path, line, side }) => {
    const threads = await getThreads(path, line, side);

    if (threads.length === 0) {
      return {
        content: [{
          type: "text",
          text: `No existing threads at ${path}:${line}${side ? ` (${side})` : ""}.`,
        }],
      };
    }

    const summary = threads.map(t =>
      `- thread_id=${t.id}, side=${t.side}, comments=${t.count}, last_activity=${t.lastActivity}`
    ).join("\n");

    return {
      content: [{
        type: "text",
        text: `Threads at ${path}:${line}:\n${summary}`,
      }],
    };
  },
};
```

### The Termination Pattern

Tools that signal the agent should stop:

```typescript
const postSummaryTool: AgentTool<typeof SummaryParams> = {
  name: "post_summary",
  description: `
Posts the final review summary. This MUST be your last action.
After calling this tool, do not make any more tool calls.

The summary should include:
- Overall verdict (Approve, Request Changes, or Comment)
- Key findings
- Any blocking issues
`,
  parameters: Type.Object({
    body: Type.String({ description: "The summary markdown" }),
  }),
  execute: async (toolCallId, { body }, signal, onUpdate, context) => {
    // Prevent duplicate summaries
    if (context.summaryPosted) {
      return {
        content: [{
          type: "text",
          text: "Summary already posted. Do not call this tool again.",
        }],
      };
    }

    await postSummary(body);
    context.summaryPosted = true;

    return {
      content: [{
        type: "text",
        text: "Summary posted. Review complete. Do not make any more tool calls.",
      }],
    };
  },
};
```

### The Caching Pattern

Tools that cache results to avoid redundant work:

```typescript
function createGithubTools(octokit: Octokit, config: Config) {
  // Cache scoped to this tool set instance
  let prInfoCache: PrInfo | null = null;
  let changedFilesCache: string[] | null = null;

  const getPrInfoTool: AgentTool<typeof EmptyParams> = {
    name: "get_pr_info",
    description: "Gets PR title, body, author, and refs. Cached after first call.",
    parameters: Type.Object({}),
    execute: async () => {
      if (!prInfoCache) {
        prInfoCache = await fetchPrInfo(octokit, config);
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify(prInfoCache, null, 2),
        }],
      };
    },
  };

  return [getPrInfoTool, /* ... */];
}
```

### The Scoped Tools Pattern

Create different tool variants for different contexts:

```typescript
function createReadTools(rootPath: string) {
  // Helper to prevent path traversal
  function ensureInsideRoot(path: string): string {
    const resolved = resolve(rootPath, path);
    if (!resolved.startsWith(rootPath)) {
      throw new Error(`Path ${path} is outside allowed root`);
    }
    return resolved;
  }

  const readTool: AgentTool<typeof ReadParams> = {
    name: "read",
    description: `Reads a file. Paths are relative to ${rootPath}.`,
    parameters: ReadParams,
    execute: async (toolCallId, { path }) => {
      const fullPath = ensureInsideRoot(path);
      const content = await fs.readFile(fullPath, "utf-8");
      return { content: [{ type: "text", text: content }] };
    },
  };

  return [readTool];
}
```

## Tool Composition

### Related Tools as a Set

Group related tools that work together:

```typescript
function createReviewTools(context: ReviewContext): AgentTool<any>[] {
  return [
    createCommentTool(context),
    createSuggestTool(context),
    createReplyTool(context),
    createListThreadsTool(context),
    createPostSummaryTool(context),
  ];
}
```

### Shared State Between Tools

Use closures to share state:

```typescript
function createReviewToolsWithState(octokit: Octokit) {
  // Shared state
  const state = {
    commentsPosted: 0,
    suggestionsPosted: 0,
    summaryPosted: false,
  };

  // Shared callback for tracking
  const onComment = () => state.commentsPosted++;
  const onSuggest = () => state.suggestionsPosted++;

  return {
    tools: [
      createCommentTool(octokit, onComment),
      createSuggestTool(octokit, onSuggest),
      createPostSummaryTool(octokit, state),
    ],
    getState: () => ({ ...state }),
  };
}
```

### Tool Dependencies

Some tools depend on others being called first:

```typescript
const getDiffTool: AgentTool<typeof DiffParams> = {
  name: "get_diff",
  description: `
Gets the diff for a specific file.

Note: Call get_changed_files first to see which files have diffs.
Calling this on an unchanged file returns empty.
`,
  parameters: Type.Object({
    path: Type.String({ description: "File path from get_changed_files" }),
  }),
  execute: async (toolCallId, { path }) => {
    const diff = await fetchDiff(path);
    if (!diff) {
      return {
        content: [{
          type: "text",
          text: `No diff for ${path}. This file may not be in the changed files list. ` +
                `Call get_changed_files to see which files changed.`,
        }],
      };
    }
    return { content: [{ type: "text", text: diff }] };
  },
};
```

## Testing Tools

### Test Return Values, Not Internals

```typescript
import { test, expect } from "bun:test";

test("comment tool requires thread_id when multiple threads exist", async () => {
  const mockOctokit = createMockOctokit();
  const tools = createReviewTools(mockOctokit, {
    existingThreads: [
      { id: 1, path: "test.ts", line: 10, side: "RIGHT" },
      { id: 2, path: "test.ts", line: 10, side: "RIGHT" },
    ],
  });

  const commentTool = tools.find(t => t.name === "comment")!;
  const result = await commentTool.execute("call-1", {
    path: "test.ts",
    line: 10,
    body: "Test comment",
  });

  // Should not post, should return guidance
  expect(mockOctokit.calls).toHaveLength(0);
  expect(result.content[0].text).toContain("Multiple threads exist");
  expect(result.content[0].text).toContain("thread_id");
});
```

### Test Edge Cases

```typescript
test("read tool handles binary files", async () => {
  const tools = createFsTools("/repo");
  const readTool = tools.find(t => t.name === "read")!;

  const result = await readTool.execute("call-1", {
    path: "image.png",
  });

  expect(result.content[0].text).toContain("binary file");
});

test("read tool prevents path traversal", async () => {
  const tools = createFsTools("/repo");
  const readTool = tools.find(t => t.name === "read")!;

  await expect(
    readTool.execute("call-1", { path: "../../../etc/passwd" })
  ).rejects.toThrow("outside allowed root");
});
```

## Summary

1. **Descriptions teach**: Tool descriptions are documentation for the LLM
2. **Parameters guide**: Use parameter descriptions and constraints to prevent misuse
3. **Return values steer**: Use results to guide next actions, especially on ambiguity
4. **Gatekeepers protect**: Validate inputs and reject invalid requests informatively
5. **Discovery helps**: Provide tools that let the agent explore what's available
6. **State enables coordination**: Share state between tools when needed
7. **Test behavior**: Verify that tools return correct guidance, not just correct results
