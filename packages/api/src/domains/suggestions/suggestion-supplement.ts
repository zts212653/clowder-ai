import type { SuggestionView } from '@cat-cafe/shared';
import type { ISuggestionStore, SuggestionRecord } from './SuggestionStore.js';
import { toSuggestionView } from './suggestion-projection.js';
import type { SuggestionResult } from './suggestion-service-contract.js';

/** Preserve the existing action and its counters; the same shared row carries the watcher's supplement. */
export async function attachWatcherSupplement(
  store: ISuggestionStore,
  id: string,
  receipt: SuggestionRecord,
  now: () => number,
  publish: (row: SuggestionRecord) => void,
): Promise<SuggestionResult<SuggestionView>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await store.get(id);
    if (!row || row.userId !== receipt.userId || row.threadId !== receipt.threadId || !receipt.receipt)
      return { ok: false, code: 'conflict', error: 'The original row is unavailable' };
    if (
      (row.byline === 'watcher' && row.receipt?.text === receipt.receipt.text) ||
      (row.watcherSupplement?.catId === receipt.catId && row.watcherSupplement.text === receipt.receipt.text)
    )
      return { ok: true, value: toSuggestionView(row) };
    const next = {
      ...row,
      watcherSupplement: { catId: receipt.catId, text: receipt.receipt.text },
      revision: row.revision + 1,
      updatedAt: now(),
    };
    if ((await store.swap(next, row.revision)).kind === 'swapped') {
      publish(next);
      return { ok: true, value: toSuggestionView(next) };
    }
  }
  return { ok: false, code: 'conflict', error: 'The original row changed; the supplement has not been attached' };
}
