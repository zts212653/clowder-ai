/** A removed pool entry is not proof that its process (or native writer) has exited. */
export class AcpRetirementBarrier {
  private readonly pending = new Map<string, Set<Promise<void>>>();

  track(key: string, close: () => Promise<void>): Promise<void> {
    const entries = this.pending.get(key) ?? new Set<Promise<void>>();
    this.pending.set(key, entries);
    const finished = close().then(() => {
      entries.delete(finished);
      if (entries.size === 0) this.pending.delete(key);
    });
    entries.add(finished);
    // Keep failed retirement as a barrier. Ignoring it could admit a second native writer.
    void finished.catch(() => {});
    return finished;
  }

  async wait(key: string): Promise<void> {
    let entries = this.pending.get(key);
    while (entries) {
      await Promise.all(entries);
      entries = this.pending.get(key);
    }
  }

  async drain(): Promise<void> {
    await Promise.all([...this.pending.values()].flatMap((entries) => [...entries]));
  }
}
