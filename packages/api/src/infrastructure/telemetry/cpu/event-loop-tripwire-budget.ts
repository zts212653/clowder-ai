/** One bounded diagnostic stream per process; time is monotonic so sleep/wall changes cannot reset it. */
export class TripwireLogBudget {
  private since: number | undefined;
  private records = 0;
  private bytes = 0;
  private droppedRecords = 0;
  private droppedBytes = 0;

  take(bytes: number, now: number) {
    const summary = this.since !== undefined && now - this.since >= 60000 ? this.drain(now) : undefined;
    this.since ??= now;
    const allowed = this.records < 30 && this.bytes + bytes <= 16384;
    if (allowed) {
      this.records++;
      this.bytes += bytes;
    } else {
      this.droppedRecords++;
      this.droppedBytes += bytes;
    }
    return { allowed, summary };
  }

  drain(now: number) {
    const summary = this.droppedRecords
      ? {
          kind: 'event_loop_observer_suppressed',
          windowStartMs: this.since,
          windowEndMs: now,
          droppedRecords: this.droppedRecords,
          droppedBytes: this.droppedBytes,
        }
      : undefined;
    this.since = now;
    this.records = this.bytes = this.droppedRecords = this.droppedBytes = 0;
    return summary;
  }
}
