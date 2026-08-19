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

  async next(): Promise<IteratorResult<unknown>> {
    const value = this.values.shift();
    if (value !== undefined) return { value, done: false };
    if (this.terminalError) throw this.terminalError;
    if (this.closed) return { value: undefined, done: true };
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}
