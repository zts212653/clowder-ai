import { LiveCarrierUnavailableError } from '../../LiveCarrierOperationGate.js';
import type { LiveContextGate, LiveContextScope } from '../live-controlled-context.js';

export interface LivePageResultNotice {
  scope: LiveContextScope;
  text: string;
  sourceRefs: readonly string[];
  isCurrent(): boolean;
}

/** A durable observation updates the same call; it never creates another execution grant. */
export class LivePageResultHost {
  private pending?: LivePageResultNotice;
  private controller = new AbortController();
  private running = false;
  private closed = false;

  constructor(
    private readonly context: LiveContextGate,
    private readonly wakeNative: () => void,
    private readonly canDeliver: () => boolean,
  ) {}

  queue(notice: LivePageResultNotice): void {
    if (this.closed || !notice.isCurrent() || notice.text.length > 8_000) return;
    this.controller.abort('newer_page_receipt');
    this.controller = new AbortController();
    this.pending = notice;
    this.signal();
  }

  hasPendingWake(): boolean {
    return !this.closed && Boolean(this.pending) && this.canDeliver();
  }

  signal(): void {
    if (this.hasPendingWake()) this.wakeNative();
  }

  async atBoundary(): Promise<'accepted' | 'busy' | 'cancelled' | 'idle'> {
    if (!this.hasPendingWake()) return 'idle';
    if (this.running) return 'busy';
    const notice = this.pending;
    if (!notice) return 'idle';
    if (!notice.isCurrent()) {
      this.pending = undefined;
      return 'cancelled';
    }
    const controller = this.controller;
    this.running = true;
    try {
      await this.context.inject({
        ...notice,
        kind: 'page_action_result',
        signal: controller.signal,
        authorizeSource: async () => this.pending === notice && notice.isCurrent(),
      });
      if (controller.signal.aborted) return 'cancelled';
      if (this.pending === notice) this.pending = undefined;
      return 'accepted';
    } catch (error) {
      if (controller.signal.aborted || !notice.isCurrent()) {
        if (this.pending === notice) this.pending = undefined;
        return 'cancelled';
      }
      if (error instanceof LiveCarrierUnavailableError) return 'busy';
      throw error;
    } finally {
      this.running = false;
    }
  }

  close(): void {
    this.closed = true;
    this.pending = undefined;
    this.controller.abort('call_closed');
  }
}
