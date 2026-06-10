import type { StoredEventMemory } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';
import type { MeaningMap } from './event-timeline-format';

/**
 * F227 PR-2 — EventTimeline data load (events + L0 magic-word meanings).
 *
 * Paginated by offset (cloud-review P2): a full-corpus backfill can produce more events
 * than one page, so the timeline pages with `limit`+`offset` and a "load more" affordance
 * instead of hiding everything past the first page. Kept separate from
 * event-timeline-model.ts, which is a pure (network-free) unit-tested module.
 */

/** Server caps `limit` at 200 (events route); one page = one fetch. */
export const EVENTS_PAGE_SIZE = 200;

/** A full page (count >= page size) implies a next page exists (砚砚: meta.count === limit). */
export function hasNextPage(pageCount: number, pageSize: number = EVENTS_PAGE_SIZE): boolean {
  return pageCount >= pageSize;
}

/** Fetch one page of events at `offset`, newest-first, with a has-next-page flag. */
export async function loadEventsPage(offset: number): Promise<{ events: StoredEventMemory[]; hasMore: boolean }> {
  const res = await apiFetch(`/api/memory/events?limit=${EVENTS_PAGE_SIZE}&offset=${offset}`);
  if (!res?.ok) throw new Error('events fetch failed');
  const data = (await res.json()) as { events: StoredEventMemory[]; meta?: { count: number } };
  const events = data.events ?? [];
  return { events, hasMore: hasNextPage(data.meta?.count ?? events.length) };
}

/** Fetch the L0 magic-word meaning table (AC-A5); soft-fails to empty on error. */
async function loadMagicWordMeanings(): Promise<MeaningMap> {
  const res = await apiFetch('/api/memory/magic-words');
  const data = res?.ok
    ? ((await res.json()) as { magicWords: { word: string; meaning: string; action: string }[] })
    : { magicWords: [] };
  const meanings: MeaningMap = {};
  for (const m of data.magicWords ?? []) meanings[m.word] = { meaning: m.meaning, action: m.action };
  return meanings;
}

/** Initial load: first events page + L0 meanings in parallel. */
export async function loadTimelineData(): Promise<{
  events: StoredEventMemory[];
  meanings: MeaningMap;
  hasMore: boolean;
}> {
  const [page, meanings] = await Promise.all([loadEventsPage(0), loadMagicWordMeanings()]);
  return { events: page.events, meanings, hasMore: page.hasMore };
}
