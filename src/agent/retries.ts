export async function withRetries(
  fn: () => Promise<void>,
  attempts: number,
  shouldRetry: (error: unknown) => boolean
): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fn();
      return;
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error)) {
        throw error;
      }
      const waitMs = 1000 * Math.pow(2, i);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastError;
}
