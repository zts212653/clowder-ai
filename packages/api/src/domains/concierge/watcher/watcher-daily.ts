import type { TurnExecutionRecord, WatcherUsage } from '@cat-cafe/shared';

export interface WatcherDailyRow {
  threadId: string;
  wakeIds: string[];
  count: number;
  modelAttempts: number;
  failed: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  rewrittenTokens: number | null;
  workingContextTokens: number | null;
}
const metrics = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'rewrittenTokens'] as const;
/** Missing provider facts remain unknown. Logical sources and actual accepted native turns are separate facts. */
export function watcherDailyRows(
  records: readonly TurnExecutionRecord[],
  inDay: (at: number) => boolean = () => true,
): WatcherDailyRow[] {
  const rows = new Map<string, WatcherDailyRow>();
  for (const record of records) {
    if (record.executionKind !== 'watcher') continue;
    const logicalDay = inDay(record.startedAt);
    const attempts = Object.values(record.watcherModelAttempts ?? {}).filter((attempt) => inDay(attempt.startedAt));
    if (!logicalDay && attempts.length === 0) continue;
    const row = rows.get(record.threadId) ?? {
      threadId: record.threadId,
      wakeIds: [],
      count: 0,
      modelAttempts: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      rewrittenTokens: 0,
      workingContextTokens: 0,
    };
    const wakeId = `${record.catId}:${record.causal?.watcherSourceInvocationId ?? record.invocationId}`;
    if (logicalDay && !row.wakeIds.includes(wakeId)) row.wakeIds.push(wakeId);
    row.count = row.wakeIds.length;
    if (logicalDay && record.status !== 'succeeded') row.failed++;
    row.modelAttempts += attempts.length;
    // An empty filtered day is known zero; only older records lack the request-level owner facts.
    const usages: (WatcherUsage | undefined)[] =
      record.watcherModelAttempts === undefined ? [record.watcherUsage] : attempts.map((attempt) => attempt.usage);
    for (const usage of usages) {
      for (const field of metrics)
        row[field] = row[field] !== null && usage?.[field] !== undefined ? row[field] + usage[field] : null;
      row.workingContextTokens =
        row.workingContextTokens !== null && usage?.workingContextTokens !== undefined
          ? Math.max(row.workingContextTokens, usage.workingContextTokens)
          : null;
    }
    rows.set(record.threadId, row);
  }
  return [...rows.values()];
}
