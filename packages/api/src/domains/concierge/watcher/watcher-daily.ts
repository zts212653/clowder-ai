import {
  summarizeWatcherDailyRow,
  type TurnExecutionRecord,
  type WatcherDailyContribution,
  type WatcherDailyRow,
} from '@cat-cafe/shared';

type DailyUsagePart = Omit<WatcherDailyContribution, 'invocationId' | 'wakeId' | 'failed'>;
/** Project durable facts; undated legacy totals are never charged to a guessed request day. */
export function watcherDailyRows(
  records: readonly TurnExecutionRecord[],
  inDay: (at: number) => boolean = () => true,
  legacyOverlapsDay: (start: number, end: number | undefined) => boolean = (start, end) =>
    inDay(start) || (end !== undefined && inDay(end)),
): WatcherDailyRow[] {
  const rows = new Map<string, WatcherDailyContribution[]>();
  for (const record of records) {
    if (record.executionKind !== 'watcher') continue;
    const logicalDay = inDay(record.startedAt);
    const part = dailyUsagePart(record, inDay);
    const relevant =
      logicalDay || (part.legacy ? legacyOverlapsDay(record.startedAt, part.endedAt) : part.usages.length > 0);
    if (!relevant) continue;
    const contributions = rows.get(record.threadId) ?? [];
    contributions.push({
      ...part,
      invocationId: record.invocationId,
      ...(logicalDay
        ? { wakeId: `${record.catId}:${record.causal?.watcherSourceInvocationId ?? record.invocationId}` }
        : {}),
      failed: logicalDay && record.status !== 'succeeded',
    });
    rows.set(record.threadId, contributions);
  }
  return [...rows].map(([threadId, contributions]) => summarizeWatcherDailyRow(threadId, contributions));
}

function dailyUsagePart(record: TurnExecutionRecord, inDay: (at: number) => boolean): DailyUsagePart {
  if (record.watcherModelAttempts !== undefined)
    return {
      legacy: false,
      usages: Object.values(record.watcherModelAttempts)
        .filter((attempt) => inDay(attempt.startedAt))
        .map((attempt) => attempt.usage ?? null),
    };
  const ends = [record.endedAt, record.providerTeardownAt, record.watcherUsage?.reportedAt].filter(
    (at): at is number => at !== undefined,
  );
  const endedAt = record.endedAt !== undefined ? Math.max(...ends) : undefined;
  const known = endedAt !== undefined && endedAt >= record.startedAt && inDay(record.startedAt) && inDay(endedAt);
  return {
    legacy: true,
    startedAt: record.startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(known ? { legacyDayKnown: true } : {}),
    usages: [record.watcherUsage ?? null],
  };
}
