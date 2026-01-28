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
  compactionModel?: string;
  maxFiles: number;
  ignorePatterns: string[];
  repoRoot: string;
  debug: boolean;
  reasoning: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  temperature?: number;
}

export type ToolCategory =
  | "filesystem"
  | "git.read"
  | "git.history"
  | "github.read"
  | "github.write"
  | "repo.write";

export type CommentType = "issue" | "review" | "both";

export type Severity = "low" | "medium" | "high";

export type OutputFormat = "findings" | "narrative" | "checklist";

export interface IncludeExclude {
  include?: string[];
  exclude?: string[];
}

export interface LimitsConfig {
  maxFiles?: number;
  maxFindings?: number;
  maxDiffLines?: number;
}

export interface ReviewDefaults {
  provider?: string;
  model?: string;
  reasoning?: ReviewConfig["reasoning"];
  temperature?: number;
}

export interface CommandDefinition {
  id: string;
  title?: string;
  prompt: string;
  tools?: {
    allow?: ToolCategory[];
  };
  limits?: LimitsConfig;
  output?: {
    format?: OutputFormat;
    severityFloor?: Severity;
  };
  comment?: {
    type?: CommentType;
  };
  files?: IncludeExclude;
}

export interface SchedulePrConfig {
  base: string;
  title: string;
  body?: string;
}

export interface ScheduleConfig {
  enabled?: boolean;
  runs?: Record<string, string[]>;
  pr?: SchedulePrConfig;
  limits?: LimitsConfig;
  conditions?: {
    paths?: IncludeExclude;
    branch?: IncludeExclude;
  };
  writeScope?: IncludeExclude;
}

export interface ReviewercConfig {
  version: 1;
  review?: {
    defaults?: ReviewDefaults;
    run?: string[];
  };
  commands?: CommandDefinition[];
  schedule?: ScheduleConfig;
  tools?: {
    allowlist?: ToolCategory[];
  };
  output?: {
    commentType?: CommentType;
  };
}

export interface ActionConfig {
  review: ReviewConfig;
  reviewRun: string[];
  commands: CommandDefinition[];
  schedule?: ScheduleConfig;
  toolsAllowlist: ToolCategory[];
  outputCommentType: CommentType;
  botName?: string;
}

export interface ReviewContext {
  owner: string;
  repo: string;
  prNumber: number;
}

export interface ExistingComment {
  id: number;
  author: string;
  authorType?: string;
  authorAssociation?: string;
  body: string;
  url: string;
  type: "issue" | "review";
  path?: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
  inReplyToId?: number;
  updatedAt: string;
}

export interface ReviewThreadInfo {
  id: number;
  threadId?: string;
  path: string;
  line: number | null;
  side?: "LEFT" | "RIGHT";
  isOutdated: boolean;
  resolved: boolean;
  lastUpdatedAt: string;
  lastActor: string;
  rootCommentId: number | null;
  url: string;
}
