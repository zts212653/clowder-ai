function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function timeoutError(): Error {
  const error = new Error('网络请求超时，请重试。');
  error.name = 'TimeoutError';
  return error;
}

/**
 * Bound native fetch even when a test double or broken transport ignores its
 * AbortSignal. A conforming fetch is still cancelled so the loser of the race
 * does not keep consuming browser resources.
 */
export async function boundedFetch(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const callerSignal = init.signal;
  if (callerSignal?.aborted) throw abortReason(callerSignal);

  const controller = new AbortController();
  let rejectBoundary!: (reason: unknown) => void;
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
  });
  const abortFromCaller = () => {
    const reason = callerSignal
      ? abortReason(callerSignal)
      : new DOMException('The operation was aborted.', 'AbortError');
    controller.abort(reason);
    rejectBoundary(reason);
  };
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    const error = timeoutError();
    controller.abort(error);
    rejectBoundary(error);
  }, timeoutMs);

  try {
    return await Promise.race([
      fetch(input, {
        ...init,
        signal: controller.signal,
      }),
      boundary,
    ]);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}

/** Wait on shared work without allowing one caller's abort to cancel it for peers. */
export function waitForPromiseWithSignal<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
