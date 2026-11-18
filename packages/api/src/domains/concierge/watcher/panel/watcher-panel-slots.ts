/** FIFO counting gate for panel member runs across all threads; capacity is read at each admission. */
export class WatcherPanelSlots {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly capacity: () => number) {}

  get inUse(): number {
    return this.running;
  }

  async acquire(signal: AbortSignal): Promise<() => void> {
    while (this.running >= this.capacity()) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          const index = this.waiting.indexOf(wake);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(signal.reason);
        };
        this.waiting.push(wake);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    signal.throwIfAborted();
    this.running++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running--;
      this.waiting.shift()?.();
    };
  }
}
