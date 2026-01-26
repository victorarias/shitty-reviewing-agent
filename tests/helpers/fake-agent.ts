export type FakeAgentEvent = {
  type: string;
  [key: string]: any;
};

export function createFakeAgent(options?: {
  events?: FakeAgentEvent[];
  error?: string | null;
  abortError?: string | null;
}) {
  const subscribers: Array<(event: FakeAgentEvent) => void> = [];
  const state = {
    error: options?.error ?? null,
    messages: [],
  };
  return {
    state,
    subscribe(fn: (event: FakeAgentEvent) => void) {
      subscribers.push(fn);
    },
    async prompt(_input: any) {
      for (const event of options?.events ?? []) {
        for (const handler of subscribers) {
          handler(event);
        }
      }
      for (const handler of subscribers) {
        handler({ type: "agent_end" });
      }
    },
    abort() {
      if (options?.abortError === undefined) {
        state.error = state.error ?? "aborted";
        return;
      }
      if (options.abortError !== null) {
        state.error = state.error ?? options.abortError;
      }
    },
  };
}
