import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolCategory } from "../types.js";

export const TOOL_CATEGORY_BY_NAME: Record<string, ToolCategory> = {
  read: "filesystem",
  grep: "filesystem",
  find: "filesystem",
  ls: "filesystem",
  get_pr_info: "github.read",
  get_review_context: "github.read",
  get_changed_files: "git.read",
  get_full_changed_files: "git.read",
  get_diff: "git.read",
  get_full_diff: "git.read",
  list_threads_for_location: "github.read",
  comment: "github.write",
  suggest: "github.write",
  update_comment: "github.write",
  reply_to_comment: "github.write",
  resolve_thread: "github.write",
  post_summary: "github.write",
  git_log: "git.history",
  git_diff_range: "git.history",
  write_file: "repo.write",
  apply_patch: "repo.write",
  delete_file: "repo.write",
  mkdir: "repo.write",
  // Treat web_search as read-only; gate it behind github.read allowlist.
  web_search: "github.read",
};

export function filterToolsByAllowlist(tools: AgentTool<any>[], allowlist?: ToolCategory[]): AgentTool<any>[] {
  if (!allowlist || allowlist.length === 0) return tools;
  const allowed = new Set(allowlist);
  return tools.filter((tool) => {
    const category = TOOL_CATEGORY_BY_NAME[tool.name];
    if (!category) return false;
    return allowed.has(category);
  });
}
