interface IdempotentInput {
  clientMessageId: string;
}

interface Entry<O> {
  fingerprint: string;
  promise: Promise<O>;
}

/** Share concurrent work and retain a bounded process-local success receipt for callback retries. */
export function createBoundedIdempotentRunner<I extends IdempotentInput, O>(options: {
  run: (input: I) => Promise<O>;
  fingerprint: (input: I) => string;
  collision: () => O;
  shouldCache: (output: O) => boolean;
  maxCompleted?: number;
  completedTtlMs?: number;
}): (input: I) => Promise<O> {
  const inFlight = new Map<string, Entry<O>>();
  const completed = new Map<string, { fingerprint: string; output: O; cachedAt: number }>();
  const maxCompleted = options.maxCompleted ?? 128;
  const completedTtlMs = options.completedTtlMs ?? 5 * 60_000;

  return (input) => {
    const key = input.clientMessageId;
    const fingerprint = options.fingerprint(input);
    const settled = completed.get(key);
    if (settled) {
      if (Date.now() - settled.cachedAt <= completedTtlMs) {
        return Promise.resolve(settled.fingerprint === fingerprint ? settled.output : options.collision());
      }
      completed.delete(key);
    }
    const active = inFlight.get(key);
    if (active) return active.fingerprint === fingerprint ? active.promise : Promise.resolve(options.collision());

    const promise = options
      .run(input)
      .then((output) => {
        if (options.shouldCache(output)) {
          completed.set(key, { fingerprint, output, cachedAt: Date.now() });
          while (completed.size > maxCompleted) {
            const oldest = completed.keys().next().value;
            if (oldest === undefined) break;
            completed.delete(oldest);
          }
        }
        return output;
      })
      .finally(() => {
        if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
      });
    inFlight.set(key, { fingerprint, promise });
    return promise;
  };
}
