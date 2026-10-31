import type { MemoryRecallPageData, RecallLedger } from '../recall-page-types';
import type { TasteBrowse, TasteMemory } from '../taste-types';

export type Reply = { ok: boolean; json: () => Promise<unknown> };
export const response = (body: unknown, ok = true): Reply => ({ ok, json: async () => body });
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function recallRow(id = 'event-coordinate', query = '真实检索词'): MemoryRecallPageData['records'][number] {
  return {
    threadId: 'thread-coordinate',
    threadTitle: '真实对话',
    event: {
      id,
      catId: 'sonnet',
      invocationId: `inv-${id}`,
      query,
      timestamp: 80,
      source: 'pull',
      toolName: 'search_evidence',
      resultCount: 0,
      resultStatus: 'no_results',
      results: [],
    },
  };
}
export function page(overrides: Partial<MemoryRecallPageData> = {}): MemoryRecallPageData {
  return {
    days: 7,
    from: 1,
    to: 100,
    readStatus: 'ready',
    records: [recallRow()],
    replies: [],
    nextCursor: null,
    ...overrides,
  };
}
export function ledger(days = 7): RecallLedger {
  return {
    days,
    from: 1,
    to: 100,
    rows: [
      { source: 'pull', surface: 'search_evidence', presented: 4, inspected: 2, used: 2 },
      { source: 'push', surface: 'session_bootstrap', presented: 3, inspected: 0, used: 0 },
    ],
  };
}
export function tasteEntry(id: string, hits: number, presented = 1): TasteMemory {
  return {
    id,
    revision: 'revision-coordinate',
    visibility: 'private',
    title: `品味 ${hits}`,
    when: '2026-10-04',
    quotes: ['保留真实来源'],
    scene: '共创',
    takeaway: null,
    tags: [],
    dimension: null,
    catId: 'sonnet',
    recall: {
      namedDelivery: { counts: { presented, drilled: 0, applied: 0, dismissed: 0 } },
      search: { hits, opened: 0, unverified: 0 },
    },
  };
}
export function taste(entries: TasteMemory[] = []): TasteBrowse {
  return {
    readStatus: 'ready',
    entries,
    coverage: { unverified: 0 },
    dimensionHints: { presented: 0, drilled: 0, applied: 0, dismissed: 0 },
  };
}
