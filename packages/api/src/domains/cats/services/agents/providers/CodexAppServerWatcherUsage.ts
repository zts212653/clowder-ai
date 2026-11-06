import { asCodexAppServerRecord } from './CodexAppServerEventMapper.js';

/** Native totals can span resumed turns. Establish this turn's baseline from its first total minus last request. */
export class WatcherTokenUsage {
  private baseline: Record<string, number> | undefined;
  private latest: Record<string, number> | undefined;
  observe(value: unknown): void {
    const usage = asCodexAppServerRecord(value);
    const last = asCodexAppServerRecord(usage?.last);
    const total = asCodexAppServerRecord(usage?.total);
    if (!last || !total) return;
    const first = !this.baseline;
    this.baseline ??= {};
    const result: Record<string, number> = {};
    for (const [native, field] of [
      ['inputTokens', 'input_tokens'],
      ['outputTokens', 'output_tokens'],
      ['cachedInputTokens', 'cached_input_tokens'],
    ] as const) {
      const recent = last[native],
        cumulative = total[native];
      if (
        typeof recent !== 'number' ||
        typeof cumulative !== 'number' ||
        !Number.isSafeInteger(recent) ||
        !Number.isSafeInteger(cumulative) ||
        recent < 0 ||
        cumulative < recent
      )
        continue;
      if (first) this.baseline[field] = cumulative - recent;
      if (this.baseline[field] === undefined) continue;
      if (cumulative < this.baseline[field]) throw new Error('watcher_provider_usage_total_regressed');
      result[field] = cumulative - this.baseline[field];
    }
    this.latest = result;
  }
  value(): Record<string, number> | undefined {
    return this.latest;
  }
}
