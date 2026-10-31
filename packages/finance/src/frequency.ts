import type { QueryFrequencyCounter } from './types.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export class QueryFrequencyTracker implements QueryFrequencyCounter {
  private readonly events = new Map<string, Date[]>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  record(key: string, at: Date = this.now()): void {
    const events = this.events.get(key) ?? [];
    events.push(at);
    this.events.set(key, events);
  }

  countLast7Days(key: string, now: Date = this.now()): number {
    const threshold = now.getTime() - SEVEN_DAYS_MS;
    const kept = (this.events.get(key) ?? []).filter((event) => event.getTime() >= threshold);
    this.events.set(key, kept);
    return kept.length;
  }
}
