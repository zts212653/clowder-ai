import { openTripwireLog } from './event-loop-tripwire-log.js';
import type { LoopStallSpan } from './event-loop-tripwire-state.js';
import { ProcessWitness } from './process-witness.js';

/** Large kernel-counter evidence never consumes the code journal or passes through API callbacks. */
export class EventLoopResourceObserver {
  private readonly sink;
  private readonly witness;
  private failureReported = false;
  private readonly lastWrites = new WeakMap<LoopStallSpan, number>();

  constructor(
    logDir: string,
    mainThreadId: string | undefined,
    private readonly reportFailure: () => void,
  ) {
    try {
      this.sink = openTripwireLog(logDir, 'resources');
    } catch {
      this.sink = undefined;
    }
    this.witness = new ProcessWitness(mainThreadId);
  }

  healthy(now: number) {
    if (this.sink) this.witness.healthy(now);
  }

  observe(span: LoopStallSpan, bootId: string | undefined, now: number) {
    const end = span.endMs ?? now;
    if (end - span.startMs < 1500) return;
    if (span.endMs === undefined && now - (this.lastWrites.get(span) ?? -Infinity) < 5000) return;
    this.lastWrites.set(span, now);
    const result = this.sink?.write({
      kind: 'event_loop_resources',
      pid: process.pid,
      bootId,
      observedAt: Date.now(),
      episode: `${process.pid}:${Math.round(span.startMs * 1000)}`,
      startMs: span.startMs,
      endMs: span.endMs,
      phase: span.endMs === undefined ? 'ongoing' : 'complete',
      observerGap: span.reason ?? null,
      resources: this.witness.capture(span, span.startMs),
    });
    if ((!result || result.status === 'failed') && !this.failureReported) {
      this.failureReported = true;
      this.reportFailure();
    }
  }

  close() {
    this.sink?.close();
  }
}
