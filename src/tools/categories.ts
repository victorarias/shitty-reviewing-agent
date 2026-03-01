import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolCategory } from "../types.js";

export const TOOL_CATEGORY_BY_NAME: Record<string, ToolCategory> = {
  subagent: "agent.subagent",
  read: "filesystem",
  grep: "filesystem",
  find: "filesystem",
  ls: "filesystem",
  validate_mermaid: "filesystem",
  get_pr_info: "github.pr.read",
  get_review_context: "github.pr.read",
  get_changed_files: "git.read",
  get_full_changed_files: "git.read",
  get_diff: "git.read",
  get_full_diff: "git.read",
  list_threads_for_location: "github.pr.read",
  comment: "github.pr.feedback",
  suggest: "github.pr.feedback",
  update_comment: "github.pr.feedback",
  reply_comment: "github.pr.feedback",
  resolve_thread: "github.pr.feedback",
  report_finding: "github.pr.feedback",
  report_key_file: "github.pr.feedback",
  report_observation: "github.pr.feedback",
  set_summary_mode: "github.pr.feedback",
  post_summary: "github.pr.feedback",
  push_pr: "github.pr.manage",
  git_log: "git.history",
  git_diff_range: "git.history",
  git: "git.history",
  write_file: "repo.write",
  apply_patch: "repo.write",
  delete_file: "repo.write",
  mkdir: "repo.write",
  // Treat web_search as read-only; gate it behind github.pr.read allowlist.
  web_search: "github.pr.read",
};

export function filterToolsByAllowlist(tools: AgentTool<any>[], allowlist?: ToolCategory[]): AgentTool<any>[] {
  if (!allowlist || allowlist.length === 0) return tools;
  const allowed = new Set(allowlist);
  return tools.filter((tool) => {
    if (tool.name === "terminate") return true;
    const category = TOOL_CATEGORY_BY_NAME[tool.name];
    if (!category) return false;
    return allowed.has(category);
  });
}
