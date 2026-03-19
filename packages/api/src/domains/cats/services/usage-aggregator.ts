/**
 * Usage Aggregator — F128
 * 纯函数：将 InvocationRecord[] 按日 × 猫聚合 token 消耗。
 */

import type { InvocationRecord } from './stores/ports/InvocationRecordStore.js';

/** Aggregated token stats for a single cat on a single day */
export interface CatDailyUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  invocations: number;
}

/** One day's aggregated data */
export interface DailyUsageEntry {
  date: string; // YYYY-MM-DD
  cats: Record<string, CatDailyUsage>;
  total: CatDailyUsage;
}

/** Full aggregation result */
export interface DailyUsageReport {
  period: { from: string; to: string };
  daily: DailyUsageEntry[];
  grandTotal: CatDailyUsage;
}

export interface AggregateOptions {
  days: number;
  catId?: string;
}

function emptyUsage(): CatDailyUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, invocations: 0 };
}

/** Round costUsd to avoid floating-point drift (keep 6 decimal places) */
function roundCost(usage: CatDailyUsage): CatDailyUsage {
  return { ...usage, costUsd: Math.round(usage.costUsd * 1_000_000) / 1_000_000 };
}

function toDateString(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Aggregate invocation records into a daily-by-cat usage report.
 * Pure function — no side effects, no I/O.
 */
export function aggregateUsageByDay(records: InvocationRecord[], options: AggregateOptions): DailyUsageReport {
  const now = new Date();
  const to = toDateString(now.getTime());
  const fromDate = new Date(now);
  fromDate.setDate(fromDate.getDate() - options.days + 1);
  const from = toDateString(fromDate.getTime());

  // Bucket: date -> catId -> CatDailyUsage
  const buckets = new Map<string, Map<string, CatDailyUsage>>();

  for (const record of records) {
    if (!record.usageByCat) continue;

    const date = toDateString(record.createdAt);

    for (const [catId, usage] of Object.entries(record.usageByCat)) {
      if (options.catId && catId !== options.catId) continue;

      let dayBucket = buckets.get(date);
      if (!dayBucket) {
        dayBucket = new Map();
        buckets.set(date, dayBucket);
      }

      const existing = dayBucket.get(catId) ?? emptyUsage();
      existing.inputTokens += usage.inputTokens ?? 0;
      existing.outputTokens += usage.outputTokens ?? 0;
      existing.cacheReadTokens += usage.cacheReadTokens ?? 0;
      existing.costUsd += usage.costUsd ?? 0;
      existing.invocations += 1;
      dayBucket.set(catId, existing);
    }
  }

  // Build sorted daily entries (newest first)
  const dates = [...buckets.keys()].sort((a, b) => b.localeCompare(a));
  const grandTotal = emptyUsage();
  const daily: DailyUsageEntry[] = [];

  for (const date of dates) {
    const dayBucket = buckets.get(date)!;
    const cats: Record<string, CatDailyUsage> = {};
    const dayTotal = emptyUsage();

    for (const [catId, usage] of dayBucket) {
      cats[catId] = roundCost(usage);
      dayTotal.inputTokens += usage.inputTokens;
      dayTotal.outputTokens += usage.outputTokens;
      dayTotal.cacheReadTokens += usage.cacheReadTokens;
      dayTotal.costUsd += usage.costUsd;
      dayTotal.invocations += usage.invocations;
    }

    grandTotal.inputTokens += dayTotal.inputTokens;
    grandTotal.outputTokens += dayTotal.outputTokens;
    grandTotal.cacheReadTokens += dayTotal.cacheReadTokens;
    grandTotal.costUsd += dayTotal.costUsd;
    grandTotal.invocations += dayTotal.invocations;

    daily.push({ date, cats, total: roundCost(dayTotal) });
  }

  return { period: { from, to }, daily, grandTotal: roundCost(grandTotal) };
}
