export interface PullRequestInfo {
  number: number;
  title: string;
  body: string;
  author: string;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  url: string;
}

export interface ChangedFile {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}

export interface ReviewConfig {
  provider: string;
  apiKey: string;
  modelId: string;
  maxFiles: number;
  ignorePatterns: string[];
  repoRoot: string;
  debug: boolean;
  reasoning: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  temperature?: number;
}

export interface ReviewContext {
  owner: string;
  repo: string;
  prNumber: number;
}

export interface ExistingComment {
  id: number;
  author: string;
  body: string;
  url: string;
  type: "issue" | "review";
  path?: string;
  line?: number;
  inReplyToId?: number;
  updatedAt: string;
}
