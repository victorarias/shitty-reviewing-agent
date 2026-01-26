export function makeOctokitSpy() {
  const calls: Array<{ type: string; args: any }> = [];
  const octokit = {
    rest: {
      issues: {
        createComment: async (args: any) => {
          calls.push({ type: "issue_comment", args });
          return { data: { id: 1 } };
        },
      },
      pulls: {
        createReplyForReviewComment: async (args: any) => {
          calls.push({ type: "reply", args });
          return { data: { id: 2 } };
        },
        createReviewComment: async (args: any) => {
          calls.push({ type: "review_comment", args });
          return { data: { id: 3 } };
        },
      },
      repos: {
        compareCommits: async (_args: any) => ({ data: { files: [] } }),
      },
    },
    paginate: async (_fn: any, _args: any) => [],
    request: async (_route: string, _params: any) => ({ data: [] }),
  };
  return { octokit, calls };
}
