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

  async run<T>(work: (signal: AbortSignal) => Promise<T>, reserveMs = 0, parent?: AbortSignal): Promise<T> {
    parent?.throwIfAborted();
    const availableMs = this.remainingMs - reserveMs;
    if (availableMs <= 0) throw new ContextSourceTimeout();
    const controller = new AbortController();
    const signal = parent ? AbortSignal.any([controller.signal, parent]) : controller.signal;
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let aborted: (() => void) | undefined;
    try {
      const stopped = new Promise<never>((_, reject) => {
        aborted = () => reject(signal.reason);
        signal.addEventListener('abort', aborted, { once: true });
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort(new ContextSourceTimeout());
        }, availableMs);
      });
      const result = await Promise.race([
        stopped,
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return work(signal);
        }),
      ]);
      signal.throwIfAborted();
      // Timers cannot preempt synchronous I/O or an uninterrupted microtask chain.
      if (performance.now() - started >= availableMs) {
        timedOut = true;
        throw new ContextSourceTimeout();
      }
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      if (aborted) signal.removeEventListener('abort', aborted);
      this.remainingMs = Math.max(0, this.remainingMs - (performance.now() - started));
      if (timedOut) this.remainingMs = Math.min(this.remainingMs, reserveMs);
      controller.abort();
    }
  }
}
