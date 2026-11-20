/** Own every asynchronous maintenance until its receipt/teardown has settled. No detached promises. */
export class CacheRetentionJobs {
  private readonly running = new Map<
    string,
    { userId: string; catId: string; stop: AbortController; work: Promise<void> }
  >();
  private closed = false;
  constructor(private readonly onError: (error: unknown) => void) {}

  start(
    scope: { id: string; userId: string; catId: string },
    execute: (signal: AbortSignal) => Promise<void>,
  ): boolean {
    const id = scope.id;
    if (this.closed || this.running.has(id)) return false;
    const stop = new AbortController();
    const work = Promise.resolve()
      .then(() => execute(stop.signal))
      .catch(this.onError)
      .finally(() => this.running.delete(id));
    this.running.set(id, { userId: scope.userId, catId: scope.catId, stop, work });
    return true;
  }
  abortMember(userId: string, catId: string): void {
    for (const job of this.running.values()) if (job.userId === userId && job.catId === catId) job.stop.abort();
  }
  has(id: string): boolean {
    return this.running.has(id);
  }
  async settle(): Promise<void> {
    await Promise.allSettled([...this.running.values()].map((job) => job.work));
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.running.values()) job.stop.abort();
    await this.settle();
  }
}
