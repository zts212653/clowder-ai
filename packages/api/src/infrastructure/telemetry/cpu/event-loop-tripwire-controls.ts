type Interval = { from: number; to: number };

/** Inspector request/acknowledgement overlap is elapsed waiting, never proof of CPU ownership. */
export class ProfilerControlTimeline {
  private intervals: Interval[] = [];
  private active: number | undefined;

  begin(now: number) {
    if (this.active !== undefined) throw Error('concurrent_profiler_control');
    this.active = now;
  }

  finish(now: number) {
    if (this.active === undefined) throw Error('profiler_control_not_started');
    this.intervals.push({ from: this.active, to: now });
    this.active = undefined;
  }

  overlap(from: number, to: number) {
    const clipped = (start: number, end: number) => Math.max(0, Math.min(to, end) - Math.max(from, start));
    const finished = this.intervals.reduce((total, interval) => total + clipped(interval.from, interval.to), 0);
    return finished + (this.active === undefined ? 0 : clipped(this.active, to));
  }

  prune(before: number) {
    this.intervals = this.intervals.filter((interval) => interval.to > before);
  }
}
