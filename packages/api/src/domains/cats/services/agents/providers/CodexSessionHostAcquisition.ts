export async function withCodexSessionHostAcquisition<T>(
  pending: Map<string, Promise<void>>,
  sessionId: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!sessionId) return operation();
  const previous = pending.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  pending.set(sessionId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (pending.get(sessionId) === tail) pending.delete(sessionId);
  }
}
