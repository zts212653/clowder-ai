/** Serializes operations per plugin instance; different instances proceed independently. */
export class InstanceOperationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(instanceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(instanceId) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(instanceId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(instanceId) === current) this.tails.delete(instanceId);
    }
  }
}
