export interface MessageSearchExecutionContext {
  signal?: AbortSignal;
  deadlineAt?: number;
  onTrace?: (trace: Record<string, unknown>) => void;
}

export function checkSearchExecution(context: MessageSearchExecutionContext): void {
  context.signal?.throwIfAborted();
  if (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt)
    throw new DOMException('Message search deadline exceeded', 'TimeoutError');
}

/** Stop awaiting read-only work early; discard late results. The supplied child
 * context expires with this wait, so owned resources can be disposed immediately.
 * The original request cancellation and hard deadline always outrank a soft cutoff. */
export async function readBeforeSearchCutoff<T>(
  read: (lifetime: MessageSearchExecutionContext) => Promise<T>,
  cutoffAt: number,
  context: MessageSearchExecutionContext,
): Promise<{ completed: true; value: T } | { completed: false }> {
  checkSearchExecution(context);
  if (Date.now() >= cutoffAt) return { completed: false };
  const lifetime = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const stop = new Promise<{ completed: false }>((resolve, reject) => {
      timer = setTimeout(
        () => {
          resolve({ completed: false });
          lifetime.abort(new DOMException('Message search read cutoff exceeded', 'TimeoutError'));
        },
        Math.max(0, cutoffAt - Date.now()),
      );
      if (context.signal) {
        onAbort = () => {
          reject(context.signal?.reason);
          lifetime.abort(context.signal?.reason);
        };
        context.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    const value = await Promise.race([
      Promise.resolve()
        .then(() => {
          lifetime.signal.throwIfAborted();
          return read({
            ...context,
            signal: lifetime.signal,
            deadlineAt: Math.min(cutoffAt, context.deadlineAt ?? Infinity),
          });
        })
        .then((value) => ({ completed: true as const, value })),
      stop,
    ]);
    checkSearchExecution(context);
    return value;
  } finally {
    lifetime.abort(new DOMException('Message search read finished', 'AbortError'));
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) context.signal?.removeEventListener('abort', onAbort);
  }
}
