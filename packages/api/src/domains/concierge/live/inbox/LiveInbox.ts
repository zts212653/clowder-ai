import type {
  LiveInboxBoundary,
  LiveInboxOptions,
  LiveInboxReference,
  LiveInboxResult,
} from './live-inbox-contract.js';
import { LiveInboxFairSelection, liveInboxNotice } from './live-inbox-selection.js';

interface Resident {
  reference: LiveInboxReference;
  accepted: boolean;
}

function bound(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('Invalid Live inbox bound');
  return value;
}

/** Bounded, disposable scheduling projection. Only Message/Queue owns durable responsibility. */
export class LiveInbox {
  private readonly residents = new Map<string, Resident>();
  private readonly selection = new LiveInboxFairSelection();
  private readonly capacity: number;
  private readonly batchSize: number;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private cursor: string | undefined;
  private hasMore = true;
  private rescan = false;
  private wakePending = false;
  private closed = false;
  private running = false;
  private epoch = 0;
  private controller: AbortController | undefined;

  constructor(private readonly options: LiveInboxOptions) {
    this.options = { ...options, scope: { ...options.scope } };
    this.capacity = bound(options.capacity, 128, 512);
    this.batchSize = Math.min(this.capacity, bound(options.batchSize, 10, 32));
    this.pageSize = Math.min(this.capacity, bound(options.pageSize, 50, 100));
    this.maxPages = bound(options.maxPagesPerBoundary, 4, 16);
    if (!Number.isSafeInteger(options.scope.generation) || options.scope.generation < 1)
      throw new Error('Invalid Live inbox generation');
  }

  /** Host calls after durable append/admission/receipt change, including reconnect recovery. */
  signal(): void {
    if (this.closed) return;
    this.rescan = true;
    this.requestWake();
  }

  private requestWake(): void {
    if (this.wakePending) return;
    this.wakePending = true;
    this.options.wake();
  }

  cancel(reason: string): void {
    this.epoch++;
    this.controller?.abort(reason);
    for (const resident of this.residents.values()) resident.accepted = false;
    this.cursor = undefined;
    this.hasMore = true;
  }

  close(): void {
    this.closed = true;
    this.cancel('closed');
    this.residents.clear();
  }

  async atBoundary(boundary: LiveInboxBoundary) {
    if (this.closed) return this.status('closed');
    if (boundary.generation !== this.options.scope.generation) return this.status('stale_generation');
    if (boundary.userSpeaking) return this.status('user_speaking');
    if (this.running) return this.status('busy');
    this.running = true;
    this.wakePending = false;
    const epoch = this.epoch;
    const controller = new AbortController();
    this.controller = controller;
    let detachAbort = () => {};
    try {
      const cancelled = new Promise<ReturnType<LiveInbox['status']>>((resolve) => {
        const onAbort = () => resolve(this.status('cancelled'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        detachAbort = () => controller.signal.removeEventListener('abort', onAbort);
      });
      const result = await Promise.race([this.consume(boundary, epoch, controller), cancelled]);
      if (
        result.kind !== 'busy' &&
        result.kind !== 'cancelled' &&
        result.kind !== 'successor_required' &&
        !this.closed &&
        ((this.residents.size < this.capacity && (this.hasMore || this.rescan)) ||
          [...this.residents.values()].some((item) => !item.accepted && !item.reference.nextWork))
      ) {
        // Continue bounded pages/batches by event. A full unread buffer waits for an owner read,
        // and a busy carrier waits for its next real safe boundary; neither is polled here.
        this.wakePending = false;
        queueMicrotask(() => {
          if (!this.closed) this.requestWake();
        });
      }
      return result;
    } finally {
      detachAbort();
      if (this.controller === controller) {
        this.running = false;
        this.controller = undefined;
      }
    }
  }

  private async consume(boundary: LiveInboxBoundary, epoch: number, controller: AbortController) {
    await this.refresh(epoch);
    if (epoch !== this.epoch) return this.status('cancelled');
    await this.fill(epoch);
    if (epoch !== this.epoch) return this.status('cancelled');
    // Recheck new page members too: page collection never grants publication permission.
    await this.refresh(epoch);
    if (epoch !== this.epoch) return this.status('cancelled');
    const successors = [...this.residents.values()]
      .filter((item) => item.reference.nextWork)
      .map((item) => item.reference);
    if (boundary.kind === 'idle' && successors.length) {
      // Idle is not a new child/adoption grant. Yield to the ordinary Queue owner without
      // publishing a notice, dequeuing, settling, or suppressing this source on later retries.
      return {
        ...this.status('idle'),
        kind: 'successor_required' as const,
        successorSources: structuredClone(this.selection.take(successors, this.batchSize)),
      };
    }
    const candidates = [...this.residents.values()]
      .filter((item) => !item.accepted && !item.reference.nextWork)
      .map((item) => item.reference);
    const selected = this.selection.take(candidates, this.batchSize);
    if (!selected.length) return this.status(this.residents.size >= this.capacity ? 'backpressure' : 'idle');
    const result = await this.options.deliver({
      scope: { ...this.options.scope },
      references: structuredClone(selected),
      notice: liveInboxNotice(this.options.scope.threadId, selected),
      signal: controller.signal,
    });
    if (epoch !== this.epoch || controller.signal.aborted) return this.status('cancelled');
    if (result === 'accepted') this.markAccepted(selected);
    return this.status(result);
  }

  private markAccepted(references: readonly LiveInboxReference[]): void {
    for (const reference of references) {
      const resident = this.residents.get(reference.messageId);
      if (resident) resident.accepted = true;
    }
  }

  private status(kind: Exclude<LiveInboxResult['kind'], 'successor_required'>): LiveInboxResult {
    return { kind, pending: this.residents.size, hasMore: this.hasMore || this.rescan };
  }

  private needsAttention(reference: LiveInboxReference): boolean {
    const scope = this.options.scope;
    return (
      reference.threadId === scope.threadId &&
      reference.targetCatId === scope.catId &&
      !reference.facts.handled &&
      !(reference.facts.readInCurrentContext && reference.facts.readByInvocationIds.includes(scope.invocationId))
    );
  }

  private async refresh(epoch: number): Promise<void> {
    for (const [id, resident] of this.residents) {
      const reference = await this.options.source.read(this.options.scope, id);
      if (epoch !== this.epoch) return;
      if (!reference || reference.messageId !== id || !this.needsAttention(reference)) this.residents.delete(id);
      else resident.reference = structuredClone(reference);
    }
  }

  private async fill(epoch: number): Promise<void> {
    if (!this.hasMore && this.rescan) {
      this.cursor = undefined;
      this.hasMore = true;
      this.rescan = false;
    }
    for (let page = 0; page < this.maxPages && this.hasMore && this.residents.size < this.capacity; page++) {
      const limit = Math.min(this.pageSize, this.capacity - this.residents.size);
      const result = await this.options.source.page(this.options.scope, this.cursor, limit);
      if (epoch !== this.epoch) return;
      if (result.items.length > limit || (result.hasMore && (!result.nextCursor || result.nextCursor === this.cursor)))
        throw new Error('Live inbox source violated bounded pagination');
      this.admit(result.items);
      this.cursor = result.nextCursor;
      this.hasMore = result.hasMore;
    }
  }

  private admit(references: LiveInboxReference[]): void {
    for (const reference of references) {
      if (this.needsAttention(reference) && !this.residents.has(reference.messageId))
        this.residents.set(reference.messageId, { reference: structuredClone(reference), accepted: false });
    }
  }
}
