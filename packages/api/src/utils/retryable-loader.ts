/** Share successful initialization and concurrent attempts; failures remain retryable. */
export function createRetryableLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (!pending) {
      const attempt = Promise.resolve()
        .then(load)
        .catch((error: unknown) => {
          if (pending === attempt) pending = undefined;
          throw error;
        });
      pending = attempt;
    }
    return pending;
  };
}
