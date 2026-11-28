import type { ClaudeQuotaWindow } from '@cat-cafe/shared';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** Retain unknown window keys and missing quantities rather than manufacturing a complete balance. */
export function parseClaudeQuotaWindows(value: unknown): Record<string, ClaudeQuotaWindow> | undefined {
  const raw = record(value);
  if (!raw || !Object.keys(raw).length) return undefined;
  const windows: Record<string, ClaudeQuotaWindow> = Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    const window = record(value);
    const utilization = window?.utilization;
    const resetsAt = window?.resetsAt;
    windows[key] = {
      ...(typeof utilization === 'number' && Number.isFinite(utilization) && utilization >= 0 && utilization <= 1
        ? { utilization }
        : {}),
      ...(typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt >= 0 && resetsAt < 8640000000000
        ? { resetsAt }
        : {}),
      ...(typeof window?.status === 'string' && window.status.length <= 80 ? { status: window.status } : {}),
    };
  }
  return windows;
}

export function claudeRateLimitMessage(event: Record<string, unknown>, catId: string): string {
  const info = record(event.rate_limit_info);
  const windows = parseClaudeQuotaWindows(info?.unifiedWindows);
  const utilization =
    typeof info?.utilization === 'number'
      ? info.utilization
      : typeof event.utilization === 'number'
        ? event.utilization
        : undefined;
  const seconds =
    typeof info?.resetsAt === 'number' &&
    Number.isFinite(info.resetsAt) &&
    info.resetsAt >= 0 &&
    info.resetsAt < 8640000000000
      ? info.resetsAt
      : undefined;
  const resetsAt =
    seconds === undefined
      ? typeof event.resets_at === 'string'
        ? event.resets_at
        : undefined
      : new Date(seconds * 1000).toISOString();
  return JSON.stringify({ type: 'rate_limit', catId, utilization, resetsAt, ...(windows ? { windows } : {}) });
}
