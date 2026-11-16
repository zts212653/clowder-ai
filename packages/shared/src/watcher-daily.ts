import type { WatcherUsage } from './types/watcher.js';

export const WATCHER_DAILY_METRICS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'rewrittenTokens',
  'workingContextTokens',
] as const;
export type WatcherDailyMetric = (typeof WATCHER_DAILY_METRICS)[number];

/** Read-only, day-filtered facts from one durable execution; identity makes page replay idempotent. */
export interface WatcherDailyContribution {
  invocationId: string;
  wakeId?: string;
  failed: boolean;
  legacy: boolean;
  /** Only set when the execution interval is wholly within the selected local day. */
  legacyDayKnown?: true;
  startedAt?: number;
  endedAt?: number;
  usages: (WatcherUsage | null)[];
}
/** V1 totals are complete-or-null. Keep this contract safe for an older Web build. */
export interface WatcherDailyLegacyRow extends Record<WatcherDailyMetric, number | null> {
  threadId: string;
  title?: string;
  wakeIds: string[];
  count: number;
  modelAttempts: number;
  failed: number;
}
export interface WatcherDailyRow extends WatcherDailyLegacyRow {
  /** Reported token sums; workingContextTokens is a request-budget upper-bound maximum, not actual usage. */
  knownTotals: Record<WatcherDailyMetric, number | null>;
  legacyRecords: number;
  usageSamples: number;
  reportedUsageSamples: number;
  coverage: Record<WatcherDailyMetric, number>;
  /** Numerator and denominator come from the same reported samples. */
  cacheRatio: { inputTokens: number; cacheReadTokens: number; samples: number };
  contributions: WatcherDailyContribution[];
  unattributedLegacy: WatcherDailyContribution[];
}

export function summarizeWatcherDailyRow(
  threadId: string,
  contributions: readonly WatcherDailyContribution[],
  title?: string,
): WatcherDailyRow {
  const unique = [...new Map(contributions.map((part) => [part.invocationId, part])).values()];
  const row: WatcherDailyRow = {
    threadId,
    ...(title === undefined ? {} : { title }),
    contributions: unique,
    unattributedLegacy: [],
    wakeIds: [],
    count: 0,
    modelAttempts: 0,
    failed: 0,
    legacyRecords: 0,
    usageSamples: 0,
    reportedUsageSamples: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    rewrittenTokens: 0,
    workingContextTokens: 0,
    knownTotals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      rewrittenTokens: 0,
      workingContextTokens: 0,
    },
    coverage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      rewrittenTokens: 0,
      workingContextTokens: 0,
    },
    cacheRatio: { inputTokens: 0, cacheReadTokens: 0, samples: 0 },
  };
  for (const part of unique) {
    if (part.wakeId && !row.wakeIds.includes(part.wakeId)) row.wakeIds.push(part.wakeId);
    row.failed += Number(part.failed);
    row.legacyRecords += Number(part.legacy);
    if (part.legacy && !part.legacyDayKnown) {
      row.unattributedLegacy.push(part);
      continue;
    }
    row.modelAttempts += part.legacy ? 0 : part.usages.length;
    row.usageSamples += part.usages.length;
    for (const usage of part.usages) addUsage(row, usage);
  }
  row.count = row.wakeIds.length;
  finalizeDailyMetrics(row);
  return row;
}

function finalizeDailyMetrics(row: WatcherDailyRow): void {
  for (const field of WATCHER_DAILY_METRICS) {
    // V2 keeps reported sums; V1 consumers must never read a partial sum as a complete total.
    const unassigned = row.unattributedLegacy.length > 0;
    if ((row.usageSamples > 0 || unassigned) && row.coverage[field] === 0) row.knownTotals[field] = null;
    row[field] = !unassigned && row.coverage[field] === row.usageSamples ? row.knownTotals[field] : null;
  }
}

function addUsage(row: WatcherDailyRow, usage: WatcherUsage | null): void {
  if (usage) row.reportedUsageSamples++;
  for (const field of WATCHER_DAILY_METRICS) {
    const value = usage?.[field];
    if (value === undefined) continue;
    row.coverage[field]++;
    row.knownTotals[field] =
      field === 'workingContextTokens'
        ? Math.max(row.knownTotals[field] ?? 0, value)
        : (row.knownTotals[field] ?? 0) + value;
  }
  if (usage?.inputTokens !== undefined && usage.cacheReadTokens !== undefined) {
    row.cacheRatio.inputTokens += usage.inputTokens;
    row.cacheRatio.cacheReadTokens += usage.cacheReadTokens;
    row.cacheRatio.samples++;
  }
}

/** Recompute from execution identities, so overlapping pages and page replay never add twice. */
export function mergeWatcherDailyRows(
  previous: readonly WatcherDailyRow[],
  additions: readonly WatcherDailyRow[],
): WatcherDailyRow[] {
  const rows = new Map<string, WatcherDailyRow>();
  for (const row of [...previous, ...additions]) {
    const old = rows.get(row.threadId);
    rows.set(
      row.threadId,
      summarizeWatcherDailyRow(
        row.threadId,
        [...(old?.contributions ?? []), ...row.contributions],
        row.title ?? old?.title,
      ),
    );
  }
  return [...rows.values()];
}
