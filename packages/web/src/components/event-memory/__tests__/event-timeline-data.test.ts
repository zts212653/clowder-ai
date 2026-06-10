import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { EVENTS_PAGE_SIZE, hasNextPage, loadEventsPage } from '../event-timeline-data';

/**
 * F227 PR-2 — timeline pagination (cloud-review P2).
 * A full-corpus backfill can exceed one page; the timeline must page by offset so older
 * events stay reachable instead of being hidden past the first 200.
 */

const mockApiFetch = vi.mocked(apiFetch);

describe('hasNextPage', () => {
  it('a full page implies another page exists', () => {
    expect(hasNextPage(EVENTS_PAGE_SIZE)).toBe(true);
  });

  it('a short or empty page is the last page', () => {
    expect(hasNextPage(EVENTS_PAGE_SIZE - 1)).toBe(false);
    expect(hasNextPage(0)).toBe(false);
  });
});

describe('loadEventsPage', () => {
  beforeEach(() => mockApiFetch.mockReset());

  it('requests the given offset and reports hasMore on a full page', async () => {
    const events = Array.from({ length: EVENTS_PAGE_SIZE }, (_, i) => ({ eventId: `e${i}` }));
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ events, meta: { count: EVENTS_PAGE_SIZE } }),
    } as Response);

    const page = await loadEventsPage(200);
    expect(mockApiFetch).toHaveBeenCalledWith(`/api/memory/events?limit=${EVENTS_PAGE_SIZE}&offset=200`);
    expect(page.events).toHaveLength(EVENTS_PAGE_SIZE);
    expect(page.hasMore).toBe(true);
  });

  it('a short final page sets hasMore=false (older events reachable, none hidden)', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ events: [{ eventId: 'e1' }], meta: { count: 1 } }),
    } as Response);

    const page = await loadEventsPage(0);
    expect(page.hasMore).toBe(false);
    expect(page.events).toHaveLength(1);
  });

  it('throws on a non-ok response so the caller keeps the load-more affordance', async () => {
    mockApiFetch.mockResolvedValue({ ok: false } as Response);
    await expect(loadEventsPage(0)).rejects.toThrow();
  });
});
