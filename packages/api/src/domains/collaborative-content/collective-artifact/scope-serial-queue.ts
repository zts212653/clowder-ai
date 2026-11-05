/** Owner effects and custody preparation share this queue; the persistent fence covers process restarts. */
export class CollectiveArtifactScopeQueue {
  private readonly pending = new Map<string, Promise<void>>();
  async run<T>(contentRef: string, effect: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(contentRef) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pending.set(contentRef, current);
    await previous;
    try {
      return await effect();
    } finally {
      release();
      if (this.pending.get(contentRef) === current) this.pending.delete(contentRef);
    }
  }
}
