import { mergeWatcherDailyRows, type WatcherDailyLegacyRow, type WatcherDailyRow } from '@cat-cafe/shared';

export type DailyDisplayRow = WatcherDailyRow | WatcherDailyLegacyRow;
export interface DailyPage {
  usageVersion?: 2;
  rows: (WatcherDailyRow | WatcherDailyLegacyRow)[];
  hasMore: boolean;
  nextCursor: number;
}
export function hasRequestFacts(row: WatcherDailyLegacyRow): row is WatcherDailyRow {
  return 'knownTotals' in row && 'contributions' in row;
}
export function replaceDailyPage(previous: readonly DailyPage[], next: DailyPage): DailyPage[] {
  // The settled sequence is the page identity even when a request replays its last response.
  return [...new Map([...previous, next].map((page) => [page.nextCursor, page])).values()];
}
export function dailyDisplayRows(pages: readonly DailyPage[]): DailyDisplayRow[] {
  const rows = pages.flatMap((page) => page.rows);
  if (rows.every(hasRequestFacts)) return mergeWatcherDailyRows([], rows);
  return legacyDisplayRows(rows);
}

function legacyDisplayRows(fragments: readonly WatcherDailyLegacyRow[]): WatcherDailyLegacyRow[] {
  const rows = new Map<string, WatcherDailyLegacyRow>();
  for (const part of fragments) {
    let row = rows.get(part.threadId);
    if (!row) {
      row = {
        ...part,
        wakeIds: [],
        count: 0,
        modelAttempts: 0,
        failed: 0,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        rewrittenTokens: null,
        workingContextTokens: null,
      };
      rows.set(part.threadId, row);
    }
    row.wakeIds = [...new Set([...row.wakeIds, ...part.wakeIds])];
    row.count = row.wakeIds.length;
    row.modelAttempts += part.modelAttempts;
    row.failed += part.failed;
    for (const key of [
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheCreationTokens',
      'rewrittenTokens',
    ] as const) {
      if (part[key] !== null) row[key] = (row[key] ?? 0) + part[key];
    }
    if (part.workingContextTokens !== null)
      row.workingContextTokens = Math.max(row.workingContextTokens ?? 0, part.workingContextTokens);
  }
  return [...rows.values()];
}
