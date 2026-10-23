export class ContextSourceTimeout extends Error {
  constructor() {
    super('context_source_timeout');
  }
}

/** Invocation-local I/O accounting; waiting/model time never consumes this budget. */
export class ContextSourceWorkBudget {
  private remainingMs: number;
  constructor(milliseconds = 1500) {
    this.remainingMs = milliseconds;
  }

  async run<T>(work: (signal: AbortSignal) => Promise<T>, reserveMs = 0): Promise<T> {
    const availableMs = this.remainingMs - reserveMs;
    if (availableMs <= 0) throw new ContextSourceTimeout();
    const controller = new AbortController();
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      return await Promise.race([
        work(controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new ContextSourceTimeout());
          }, availableMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.remainingMs = Math.max(0, this.remainingMs - (performance.now() - started));
      if (timedOut) this.remainingMs = Math.min(this.remainingMs, reserveMs);
      controller.abort();
    }
  }
}
