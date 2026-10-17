/**
 * Pipelines that name the same lane take turns, from gate through their last work item.
 *
 * Tasks that share one serialized external resource otherwise tick together and interleave
 * their calls. Every deadline that counts time spent queued then also pays for the other tasks'
 * calls. Taking turns lets each pipeline's deadlines measure its own I/O. A task still waiting
 * for its turn keeps its running flag, so its next tick is skipped as overlap rather than queued.
 */
export class PipelineLanes {
  private readonly tails = new Map<string, Promise<void>>();

  /** Resolves on this pipeline's turn. Call the returned release once the pipeline has finished. */
  async acquire(lane: string): Promise<() => void> {
    const previous = this.tails.get(lane) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => turn);
    this.tails.set(lane, tail);
    await previous;
    return () => {
      release();
      if (this.tails.get(lane) === tail) this.tails.delete(lane);
    };
  }
}
