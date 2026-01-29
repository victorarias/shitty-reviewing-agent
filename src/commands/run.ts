import { calculateCost } from "@mariozechner/pi-ai";
import type { Usage } from "@mariozechner/pi-ai";
import { minimatch } from "minimatch";
import type {
  ChangedFile,
  CommandDefinition,
  CommentType,
  ExistingComment,
  PullRequestInfo,
  ReviewConfig,
  ReviewContext,
  ReviewThreadInfo,
  ScheduleConfig,
  ToolCategory,
  IncludeExclude,
} from "../types.js";
import { filterToolsByAllowlist } from "../tools/categories.js";
import { applyIgnorePatterns } from "../app/ignore.js";
import { createReadOnlyTools } from "../tools/fs.js";
import { createGithubTools } from "../tools/github.js";
import { createReviewTools } from "../tools/review.js";
import { createGitHistoryTools } from "../tools/git-history.js";
import { createRepoWriteTools } from "../tools/repo-write.js";
import { createSchedulePrTools } from "../tools/schedule-pr.js";
import { createAgentWithCompaction, AgentSetupOverrides } from "../agent/agent-setup.js";

export interface CommandArgs {
  args: string;
  argv: string[];
}

export type CommandRunInput =
  | {
      mode: "pr";
      command: CommandDefinition;
      config: ReviewConfig;
      context: ReviewContext;
      octokit: ReturnType<typeof import("@actions/github").getOctokit>;
      prInfo: PullRequestInfo;
      changedFiles: ChangedFile[];
      existingComments: ExistingComment[];
      reviewThreads: ReviewThreadInfo[];
      commandArgs?: CommandArgs;
      commentType: CommentType;
      allowlist: ToolCategory[];
      logDebug?: (message: string) => void;
      overrides?: AgentSetupOverrides;
    }
  | {
      mode: "schedule";
      command: CommandDefinition;
      config: ReviewConfig;
      schedule: ScheduleConfig;
      scheduleContext: {
        jobId: string;
        commandIds: string[];
        owner: string;
        repo: string;
        octokit: ReturnType<typeof import("@actions/github").getOctokit>;
        runGitFn?: (repoRoot: string, args: string[]) => Promise<void>;
      };
      commandArgs?: CommandArgs;
      commentType: CommentType;
      allowlist: ToolCategory[];
      logDebug?: (message: string) => void;
      writeScope?: IncludeExclude;
      overrides?: AgentSetupOverrides;
    };

export async function runCommand(input: CommandRunInput): Promise<void> {
  const log = (...args: unknown[]) => {
    if (input.config.debug) {
      console.log("[debug]", ...args);
    }
  };

  const commandArgs = input.commandArgs ?? { args: "", argv: [] };
  const promptText = interpolateCommandPrompt(input.command.prompt, commandArgs);
  const allowedCategories = resolveAllowedCategories(
    input.allowlist,
    input.command.tools?.allow,
    input.mode,
    input.config.allowPrToolsInReview ?? false
  );

  const summaryState = {
    posted: false,
    inlineComments: 0,
    suggestions: 0,
    billing: {
      input: 0,
      output: 0,
      total: 0,
      cost: 0,
    },
  };

  const contextState = {
    filesRead: new Set<string>(),
    filesDiffed: new Set<string>(),
    truncatedReads: new Set<string>(),
    partialReads: new Set<string>(),
  };

  const filteredFiles =
    input.mode === "pr"
      ? filterCommandFiles(
          (input as Extract<CommandRunInput, { mode: "pr" }>).changedFiles,
          input.command,
          input.config.ignorePatterns
        )
      : null;
  if (input.mode === "pr") {
    const maxFiles = input.command.limits?.maxFiles;
    if (maxFiles && filteredFiles && filteredFiles.length > maxFiles) {
      log(`command ${input.command.id} skipped: ${filteredFiles.length} files exceeds maxFiles=${maxFiles}`);
      return;
    }
  }
  const toolInput =
    input.mode === "pr" && filteredFiles
      ? { ...(input as Extract<CommandRunInput, { mode: "pr" }>), changedFiles: filteredFiles }
      : input;
  const tools = buildTools(toolInput as CommandRunInput, allowedCategories, summaryState);
  const { agent, model } = createAgentWithCompaction({
    config: input.config,
    systemPrompt: buildSystemPrompt(input, promptText),
    tools,
    contextState,
    summaryState,
    overrides: input.overrides,
  });

  const maxIterations = 10 + input.config.maxFiles * 5;
  let toolExecutions = 0;
  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      toolExecutions += 1;
      if (event.toolName === "read" && event.args?.path) {
        contextState.filesRead.add(event.args.path);
        if (event.args.start_line || event.args.end_line) {
          contextState.partialReads.add(event.args.path);
        }
      }
      if ((event.toolName === "get_diff" || event.toolName === "get_full_diff") && event.args?.path) {
        contextState.filesDiffed.add(event.args.path);
      }
      if (toolExecutions >= maxIterations) {
        agent.abort();
      }
    }
    if (event.type === "tool_execution_end") {
      if (event.toolName === "read" && event.result?.details?.truncated && event.result?.details?.path) {
        contextState.truncatedReads.add(event.result.details.path);
      }
      if (input.config.debug && event.result) {
        log(`tool output: ${event.toolName}`, safeStringify(event.result));
      }
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const usage = event.message.usage;
      if (usage) {
        const cost = calculateCost(model, usage as Usage);
        summaryState.billing.input += usage.input;
        summaryState.billing.output += usage.output;
        summaryState.billing.total += usage.totalTokens;
        summaryState.billing.cost += cost.total;
      }
    }
  });

  const userPrompt = buildUserPrompt(input, promptText, commandArgs, filteredFiles);
  await agent.prompt(userPrompt);

  if (input.mode === "pr") {
    const hasSummaryTool = tools.some((tool) => tool.name === "post_summary");
    if (hasSummaryTool && !summaryState.posted) {
      log("command run completed without posting a summary");
    }
  }
}

function resolveAllowedCategories(
  globalAllowlist: ToolCategory[],
  commandAllow: ToolCategory[] | undefined,
  mode: "pr" | "schedule",
  allowPrToolsInReview: boolean
): ToolCategory[] {
  const base = new Set(globalAllowlist);
  let allowed = commandAllow && commandAllow.length > 0 ? commandAllow.filter((item) => base.has(item)) : [...base];
  if (mode === "pr") {
    allowed = allowed.filter((item) => item !== "repo.write");
    if (!allowPrToolsInReview) {
      allowed = allowed.filter((item) => item !== "github.pr.manage");
    }
  }
  if (mode === "schedule") {
    allowed = allowed.filter((item) => !["git.read", "github.pr.read", "github.pr.feedback"].includes(item));
  }
  return allowed;
}

function buildTools(
  input: CommandRunInput,
  allowed: ToolCategory[],
  summaryState: { posted: boolean; inlineComments: number; suggestions: number; billing: any }
) {
  const allowedSet = new Set(allowed);
  const allTools = [] as any[];

  if (allowedSet.has("filesystem")) {
    allTools.push(...createReadOnlyTools(input.config.repoRoot));
  }

  if (allowedSet.has("git.history")) {
    allTools.push(...createGitHistoryTools(input.config.repoRoot));
  }

  if (input.mode === "pr") {
    const prInput = input as Extract<CommandRunInput, { mode: "pr" }>;
    if (allowedSet.has("git.read") || allowedSet.has("github.pr.read")) {
      const githubTools = createGithubTools({
        octokit: prInput.octokit,
        owner: prInput.context.owner,
        repo: prInput.context.repo,
        pullNumber: prInput.context.prNumber,
        cache: {
          prInfo: prInput.prInfo,
          changedFiles: prInput.changedFiles,
        },
      });
      allTools.push(...githubTools);
    }

    if (allowedSet.has("github.pr.feedback")) {
      const reviewTools = createReviewTools({
        octokit: prInput.octokit,
        owner: prInput.context.owner,
        repo: prInput.context.repo,
        pullNumber: prInput.context.prNumber,
        headSha: prInput.prInfo.headSha,
        modelId: prInput.config.modelId,
        reviewSha: prInput.prInfo.headSha,
        changedFiles: prInput.changedFiles,
        getBilling: () => summaryState.billing,
        existingComments: prInput.existingComments,
        reviewThreads: prInput.reviewThreads,
        onSummaryPosted: () => {
          summaryState.posted = true;
        },
        summaryPosted: () => summaryState.posted,
        onInlineComment: () => {
          summaryState.inlineComments += 1;
        },
        onSuggestion: () => {
          summaryState.suggestions += 1;
        },
      });
      allTools.push(...filterReviewToolsByCommentType(reviewTools, prInput.commentType));
    }

    if (allowedSet.has("github.pr.manage")) {
      allTools.push(
        ...createSchedulePrTools({
          repoRoot: input.config.repoRoot,
          schedule: undefined,
          jobId: `pr-${prInput.context.prNumber}`,
          commandIds: [input.command.id],
          owner: prInput.context.owner,
          repo: prInput.context.repo,
          octokit: prInput.octokit,
        })
      );
    }
  }

  if (input.mode === "schedule") {
    const scheduleInput = input as Extract<CommandRunInput, { mode: "schedule" }>;
    if (allowedSet.has("repo.write")) {
      allTools.push(...createRepoWriteTools(input.config.repoRoot, scheduleInput.writeScope));
    }
    if (allowedSet.has("github.pr.manage")) {
      allTools.push(
        ...createSchedulePrTools({
          repoRoot: input.config.repoRoot,
          schedule: scheduleInput.schedule,
          writeScope: scheduleInput.writeScope,
          jobId: scheduleInput.scheduleContext.jobId,
          commandIds: scheduleInput.scheduleContext.commandIds,
          owner: scheduleInput.scheduleContext.owner,
          repo: scheduleInput.scheduleContext.repo,
          octokit: scheduleInput.scheduleContext.octokit,
          runGit: scheduleInput.scheduleContext.runGitFn,
        })
      );
    }
  }

  return filterToolsByAllowlist(allTools, [...allowedSet]);
}

function filterReviewToolsByCommentType(tools: any[], commentType: CommentType): any[] {
  if (commentType === "both") return tools;
  if (commentType === "issue") {
    return tools.filter((tool) => tool.name === "post_summary");
  }
  if (commentType === "review") {
    return tools.filter((tool) => tool.name !== "post_summary");
  }
  return tools;
}

function buildSystemPrompt(input: CommandRunInput, commandPrompt: string): string {
  const base = `# Role
You are a command runner inside a GitHub Action.

# Task
Execute the command described in the user prompt. The command prompt is authoritative.

# Constraints
- Use only the tools provided.
- If you can post a summary (post_summary tool), call it exactly once as your final action.
- If no summary tool is available, complete the task and stop when finished.`;

  const modeNote =
    input.mode === "schedule"
      ? "\n- This is a scheduled run with no PR context. Do not expect PR-only tools.\n- When the command requests file changes, you must use repo write tools to make those changes. Do not respond with prose in place of tool use.\n- If you want to submit changes for review, call commit_changes with a commit message, then push_pr with a PR title/body. The PR targets the repo default branch."
      : "\n- This is a PR-scoped run. You may use PR tools to gather context.";

  return `${base}${modeNote}\n\n# Command Prompt\n${commandPrompt}`;
}

function buildUserPrompt(
  input: CommandRunInput,
  commandPrompt: string,
  args: CommandArgs,
  filteredFiles: ChangedFile[] | null
): string {
  const commandMeta = `# Command\n- id: ${input.command.id}\n- title: ${input.command.title ?? "(none)"}\n- comment type: ${input.commentType}\n`;
  const argsSection = `# Command Args\n- args: ${args.args || "(none)"}\n- argv: ${args.argv.length > 0 ? JSON.stringify(args.argv) : "(none)"}\n`;
  if (input.mode === "schedule") {
    return `${commandMeta}\n${argsSection}\n# Prompt\n${commandPrompt}`;
  }
  const prInput = input as Extract<CommandRunInput, { mode: "pr" }>;
  const fileList =
    filteredFiles && filteredFiles.length > 0
      ? filteredFiles.map((file) => `- ${file.filename}`).join("\n")
      : "(none)";
  return `${commandMeta}\n${argsSection}\n# Prompt\n${commandPrompt}\n\n# PR Context\nPR title: ${prInput.prInfo.title}\nPR description: ${prInput.prInfo.body?.trim() || "(no description)"}\nHead SHA: ${prInput.prInfo.headSha}\nChanged files (after filters):\n${fileList}`;
}

function filterCommandFiles(files: ChangedFile[], command: CommandDefinition, ignorePatterns: string[]): ChangedFile[] {
  const ignored = applyIgnorePatterns(files, ignorePatterns);
  const include = command.files?.include ?? [];
  const exclude = command.files?.exclude ?? [];
  const filtered =
    include.length > 0 ? ignored.filter((file) => include.some((pattern) => minimatch(file.filename, pattern))) : ignored;
  if (exclude.length === 0) return filtered;
  return filtered.filter((file) => !exclude.some((pattern) => minimatch(file.filename, pattern)));
}

function interpolateCommandPrompt(prompt: string, args: CommandArgs): string {
  return prompt
    .replaceAll("${command.args}", args.args)
    .replaceAll("${command.argv}", JSON.stringify(args.argv));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return `[unserializable]: ${String(error)}`;
  }
}
