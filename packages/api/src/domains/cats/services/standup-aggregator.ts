/**
 * Standup Aggregator — Q12 Bootcamp
 * 纯函数：将 InvocationRecord[] 聚合为当日站会摘要。
 */

import type { InvocationRecord } from './stores/ports/InvocationRecordStore.js';

/** Per-cat standup stats for today */
export interface CatStandup {
  invocations: number;
  succeeded: number;
  failed: number;
  tokens: { input: number; output: number };
  costUsd: number;
  lastActiveAt: number | null;
  recentThreads: string[];
}

/** Full standup report */
export interface StandupReport {
  date: string;
  cats: Record<string, CatStandup>;
  summary: { totalInvocations: number; totalCostUsd: number };
}

const MAX_RECENT_THREADS = 5;

function emptyCatStandup(): CatStandup {
  return {
    invocations: 0,
    succeeded: 0,
    failed: 0,
    tokens: { input: 0, output: 0 },
    costUsd: 0,
    lastActiveAt: null,
    recentThreads: [],
  };
}

function toDateString(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Aggregate invocation records into a daily standup report.
 * Pure function — no side effects, no I/O.
 */
export function aggregateStandup(records: InvocationRecord[]): StandupReport {
  const today = toDateString(Date.now());

  const cats: Record<string, CatStandup> = {};
  const threadSets = new Map<string, Set<string>>();
  let totalInvocations = 0;
  let totalCostUsd = 0;

  for (const record of records) {
    const recordDate = toDateString(record.usageRecordedAt ?? record.updatedAt ?? record.createdAt);
    if (recordDate !== today) continue;

    totalInvocations += 1;

    for (const catId of record.targetCats) {
      const cat = cats[catId] ?? emptyCatStandup();
      cats[catId] = cat;

      cat.invocations += 1;

      if (record.status === 'succeeded') cat.succeeded += 1;
      if (record.status === 'failed') cat.failed += 1;

      const usage = record.usageByCat?.[catId];
      if (usage) {
        cat.tokens.input += usage.inputTokens ?? 0;
        cat.tokens.output += usage.outputTokens ?? 0;
        cat.costUsd += usage.costUsd ?? 0;
      }

      const ts = record.updatedAt ?? record.createdAt;
      if (cat.lastActiveAt === null || ts > cat.lastActiveAt) {
        cat.lastActiveAt = ts;
      }

      let threadSet = threadSets.get(catId);
      if (!threadSet) {
        threadSet = new Set();
        threadSets.set(catId, threadSet);
      }
      threadSet.add(record.threadId);
    }

    // Sum cost for the full invocation (not per-cat to avoid double counting)
    if (record.usageByCat) {
      for (const usage of Object.values(record.usageByCat)) {
        totalCostUsd += usage.costUsd ?? 0;
      }
    }
  }

  // Populate recentThreads (capped)
  for (const [catId, threadSet] of threadSets) {
    cats[catId].recentThreads = [...threadSet].slice(0, MAX_RECENT_THREADS);
  }

  // Round costs
  totalCostUsd = Math.round(totalCostUsd * 1_000_000) / 1_000_000;
  for (const cat of Object.values(cats)) {
    cat.costUsd = Math.round(cat.costUsd * 1_000_000) / 1_000_000;
  }

  return { date: today, cats, summary: { totalInvocations, totalCostUsd } };
}
