export interface LoopStallSpan {
  startMs: number;
  endMs?: number;
  reason?: 'observer_gap' | 'clock_change';
  workerGapMs?: number;
}

/** Monotonic main/observer progress, not a guess about which function is responsible. */
export class EventLoopTripwireState {
  current: LoopStallSpan | undefined;
  private previous: { now: number; wall: number } | undefined;
  private resumeAfterMs = -Infinity;

  constructor(
    readonly heartbeatMs: number,
    readonly thresholdMs: number,
  ) {}

  poll(now: number, wall: number, heartbeat: number): LoopStallSpan | undefined {
    const previous = this.previous;
    this.previous = { now, wall };
    const gap = previous ? Math.max(0, now - previous.now) : 0;
    const clockChange = previous ? Math.abs(wall - previous.wall - gap) : 0;
    const lag = Math.max(0, now - heartbeat - this.heartbeatMs);
    if (previous && (gap > Math.max(100, this.thresholdMs / 2) || clockChange > this.thresholdMs)) {
      this.resumeAfterMs = now;
      return this.finishGap(now, gap, clockChange, lag);
    }
    if (heartbeat <= this.resumeAfterMs) return;
    this.resumeAfterMs = -Infinity;
    if (this.current && heartbeat > this.current.startMs) {
      const completed = this.current;
      completed.endMs = heartbeat;
      this.current = lag >= this.thresholdMs ? { startMs: heartbeat + this.heartbeatMs } : undefined;
      return completed;
    }
    if (!this.current && lag >= this.thresholdMs) this.current = { startMs: heartbeat + this.heartbeatMs };
    return;
  }

  private finishGap(now: number, gap: number, clockChange: number, lag: number): LoopStallSpan | undefined {
    const open = this.current;
    this.current = undefined;
    if (!open && Math.max(lag, gap, clockChange) < this.thresholdMs) return;
    return Object.assign(open ?? {}, {
      startMs: open?.startMs ?? now - Math.max(lag, gap, clockChange),
      endMs: now,
      reason: clockChange > this.thresholdMs ? 'clock_change' : 'observer_gap',
      workerGapMs: gap,
    }) as LoopStallSpan;
  }
}
