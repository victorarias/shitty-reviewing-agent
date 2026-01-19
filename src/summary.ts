export interface SummaryContent {
  verdict: string;
  issues: string[];
  keyFindings: string[];
  multiFileSuggestions: string[];
  model: string;
  reviewSha?: string;
  billing?: {
    input: number;
    output: number;
    total: number;
    cost: number;
  };
}

export function buildSummaryMarkdown(content: SummaryContent): string {
  const billing = content.billing
    ? `\n*Billing: input ${content.billing.input} • output ${content.billing.output} • total ${content.billing.total} • cost $${content.billing.cost.toFixed(6)}*`
    : "";
  const marker = content.reviewSha ? `\n<!-- sri:last-reviewed-sha:${content.reviewSha} -->` : "";
  const multiFile = renderOptionalSection("Multi-file Suggestions", content.multiFileSuggestions);
  return `## Review Summary\n\n**Verdict:** ${content.verdict}\n\n### Issues Found\n\n${renderList(content.issues)}\n\n### Key Findings\n\n${renderList(content.keyFindings)}\n${multiFile}\n---\n*Reviewed by shitty-reviewing-agent • model: ${content.model}*${billing}${marker}`;
}

function renderList(items: string[]): string {
  if (!items || items.length === 0) {
    return "- None";
  }
  return items.map((item) => `- ${item}`).join("\n");
}

function renderOptionalSection(title: string, items: string[]): string {
  if (!items || items.length === 0 || items.every((item) => item.trim().toLowerCase() === "none")) {
    return "";
  }
  return `\n### ${title}\n\n${renderList(items)}\n`;
}
