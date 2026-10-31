export class CodexAppServerNotificationQueue {
  private values: unknown[] = [];
  private waiters: Array<{
    resolve(result: IteratorResult<unknown>): void;
    reject(error: Error): void;
  }> = [];
  private terminalError: Error | null = null;
  private closed = false;

  push(value: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  end(error?: Error): void {
    this.terminalError = error ?? null;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      if (this.terminalError) waiter.reject(this.terminalError);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  /**
   * F296 B4a: remove already-buffered notifications matching `predicate` and
   * return them, preserving the order of everything left behind.
   *
   * Used by the preflight fence to consume compaction notifications that
   * arrived for the bound runtime before the final prompt is built. It never
   * blocks and never touches values that have not arrived yet, so it cannot
   * starve or reorder the main notification loop.
   */
  takeBuffered(predicate: (value: unknown) => boolean): unknown[] {
    if (this.values.length === 0) return [];
    const taken: unknown[] = [];
    const remaining: unknown[] = [];
    for (const value of this.values) (predicate(value) ? taken : remaining).push(value);
    this.values = remaining;
    return taken;
  }

  async next(): Promise<IteratorResult<unknown>> {
    const value = this.values.shift();
    if (value !== undefined) return { value, done: false };
    if (this.terminalError) throw this.terminalError;
    if (this.closed) return { value: undefined, done: true };
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}
