import { streamSimple } from "@mariozechner/pi-ai";
import type { getModel } from "@mariozechner/pi-ai";

export function estimateTokens(messages: any[]): number {
  let chars = 0;
  for (const message of messages) {
    const content = message?.content;
    if (typeof content === "string") {
      chars += content.length;
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part?.text === "string") {
          chars += part.text.length;
        } else if (typeof part?.thinking === "string") {
          chars += part.thinking.length;
        } else {
          chars += JSON.stringify(part ?? "").length;
        }
      }
      continue;
    }
    if (content) {
      chars += JSON.stringify(content).length;
    }
  }
  return Math.ceil(chars / 4);
}

export function pruneMessages(
  messages: any[],
  tokenBudget: number
): { kept: any[]; pruned: any[]; prunedCount: number } {
  const kept: any[] = [];
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    const msgTokens = estimateTokens([msg]);
    if (tokens + msgTokens > tokenBudget) {
      break;
    }
    kept.unshift(msg);
    tokens += msgTokens;
  }
  const pruned = messages.slice(0, messages.length - kept.length);
  return { kept, pruned, prunedCount: pruned.length };
}

export async function summarizeForCompaction(
  messages: any[],
  model: ReturnType<typeof getModel>,
  apiKey: string
): Promise<string> {
  const summaryPrompt = buildCompactionPrompt(messages);
  const context = [{ role: "user", content: summaryPrompt }];
  const key = apiKey?.trim() ? apiKey : undefined;
  let output = "";
  for await (const event of streamSimple(model, context as any, { apiKey: key })) {
    if (event.type === "text_delta") {
      output += event.delta;
    }
    if (event.type === "done" && output.trim().length === 0) {
      const text = event.message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
      output += text;
    }
    if (event.type === "error" && output.trim().length === 0) {
      const text = event.error.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
      output += text;
    }
  }
  return output.trim() || buildDeterministicSummary(messages);
}

function buildCompactionPrompt(messages: any[]): string {
  const rendered = messages
    .map((msg) => {
      const role = msg.role ?? "unknown";
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map((part: any) => part.text ?? part.thinking ?? "").join("")
          : JSON.stringify(msg.content ?? "");
      const truncated = text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
      return `[${role}] ${truncated}`;
    })
    .join("\n");
  return `Summarize the following conversation context for a code review agent.\n` +
    `Focus on: key findings, decisions, outstanding issues, and files discussed.\n` +
    `Be concise and bullet-pointed.\n\n${rendered}`;
}

export function buildContextSummaryMessage(
  contextState: {
    filesRead: Set<string>;
    filesDiffed: Set<string>;
    truncatedReads: Set<string>;
    partialReads: Set<string>;
  },
  prunedCount: number,
  summaryState: { inlineComments: number; suggestions: number; posted: boolean }
): { role: string; content: string; timestamp: number } {
  const readFiles = formatSet(contextState.filesRead);
  const diffFiles = formatSet(contextState.filesDiffed);
  const truncated = formatSet(contextState.truncatedReads);
  const partial = formatSet(contextState.partialReads);
  const lines = [
    `[${prunedCount} earlier messages pruned for context limits]`,
    `Files read: ${readFiles}`,
    `Files with diffs: ${diffFiles}`,
    `Partial reads: ${partial}`,
    `Truncated reads: ${truncated}`,
    `Inline comments posted: ${summaryState.inlineComments}`,
    `Suggestions posted: ${summaryState.suggestions}`,
    `Summary posted: ${summaryState.posted ? "yes" : "no"}`,
  ];
  return {
    role: "user",
    content: `Context summary:\n${lines.map((line) => `- ${line}`).join("\n")}`,
    timestamp: Date.now(),
  };
}

export function buildDeterministicSummary(messages: any[]): string {
  const lines = messages
    .filter((msg) => msg.role === "assistant")
    .map((msg) => {
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map((part: any) => part.text ?? "").join("")
          : "";
      return text.trim();
    })
    .filter(Boolean)
    .slice(-5);
  if (lines.length === 0) {
    return "Earlier context was compacted to fit within model limits.";
  }
  return `Recent assistant outputs:\n- ${lines.join("\n- ")}`;
}

export function formatSet(values: Set<string>, limit = 8): string {
  if (values.size === 0) return "none";
  const list = Array.from(values).sort();
  if (list.length <= limit) return list.join(", ");
  return `${list.slice(0, limit).join(", ")} (+${list.length - limit} more)`;
}
