export interface StoreReadOptions {
  signal?: AbortSignal;
}

export function throwIfStoreReadAborted(options: StoreReadOptions | undefined): void {
  options?.signal?.throwIfAborted();
}

export async function awaitStoreRead<T>(operation: PromiseLike<T>, options: StoreReadOptions | undefined): Promise<T> {
  const signal = options?.signal;
  if (!signal) return operation;
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(
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
