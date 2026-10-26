export interface OfflineUsage {
  provider: 'openai' | 'anthropic';
  inputTotal: number | null;
  inputNew: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  reportedCostUsd: number | null;
  native: Readonly<Record<string, number>>;
}

/** A terminal receipt is not itself evidence that any token counter was reported. */
export function hasObservedTokens(usage: OfflineUsage): boolean {
  return Object.keys(usage.native).length > 0;
}

/** Terminal native events already aggregate their internal API rounds; count each once. */
export function sumOfflineCalls(calls: readonly { usage: readonly OfflineUsage[]; elapsedMs: number }[]) {
  const complete = calls.length > 0 && calls.every((call) => call.usage.length > 0);
  const usage = calls.flatMap((call) => call.usage);
  const sum = (field: 'inputTotal' | 'inputNew' | 'cacheRead' | 'cacheWrite' | 'output' | 'reportedCostUsd') => {
    const values = usage.map((item) => item[field]);
    return complete && values.every((value) => value !== null)
      ? values.reduce<number>((total, value) => total + (value ?? 0), 0)
      : null;
  };
  return {
    inputTotal: sum('inputTotal'),
    inputNew: sum('inputNew'),
    cacheRead: sum('cacheRead'),
    cacheWrite: sum('cacheWrite'),
    output: sum('output'),
    reportedCostUsd: sum('reportedCostUsd'),
    elapsedMs: calls.reduce((total, call) => total + call.elapsedMs, 0),
  };
}

/** This reader consumes original native events, before ordinary UI normalization. */
export function readOfflineUsage(provider: OfflineUsage['provider'], event: unknown): OfflineUsage | null {
  const item = record(event);
  const terminal =
    provider === 'anthropic' ? item.type === 'result' : item.type === 'turn.completed' || item.type === 'turn.failed';
  if (!terminal) return null;
  const raw = record(item.usage);
  const input = count(raw.input_tokens);
  const output = count(raw.output_tokens);
  const cacheRead = count(provider === 'anthropic' ? raw.cache_read_input_tokens : raw.cached_input_tokens);
  const cacheWrite = count(raw.cache_creation_input_tokens);
  const inputTotal =
    provider === 'openai'
      ? input
      : input !== null && cacheRead !== null && cacheWrite !== null
        ? input + cacheRead + cacheWrite
        : null;
  const inputNew =
    provider === 'anthropic'
      ? input
      : input !== null && cacheRead !== null && input >= cacheRead
        ? input - cacheRead
        : null;
  const keys =
    provider === 'anthropic'
      ? ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']
      : ['input_tokens', 'cached_input_tokens', 'output_tokens'];
  const native: Record<string, number> = {};
  for (const key of keys) {
    const value = count(raw[key]);
    if (value !== null) native[key] = value;
  }
  return {
    provider,
    inputTotal,
    inputNew,
    cacheRead,
    cacheWrite,
    output,
    reportedCostUsd:
      provider === 'anthropic' &&
      typeof item.total_cost_usd === 'number' &&
      Number.isFinite(item.total_cost_usd) &&
      item.total_cost_usd >= 0
        ? item.total_cost_usd
        : null,
    native,
  };
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
