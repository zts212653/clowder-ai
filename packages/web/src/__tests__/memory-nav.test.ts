/**
 * F102 Phase J: MemoryNav logic tests
 *
 * Tests referrer thread resolution, back href, and tab config generation.
 * Same pattern as SignalNav but for /memory route.
 */

import { describe, expect, it } from 'vitest';
import {
  buildBackHref,
  buildMemoryTabItems,
  type MemoryTab,
  resolveReferrerThread,
} from '@/components/memory/MemoryNav';

describe('resolveReferrerThread', () => {
  it('returns fromParam when present in URL search', () => {
    expect(resolveReferrerThread('?from=thread_abc', null)).toBe('thread_abc');
  });

  it('falls back to storeThreadId when no URL param', () => {
    expect(resolveReferrerThread('', 'store-thread-42')).toBe('store-thread-42');
  });

  it('returns null when no URL param and no store thread', () => {
    expect(resolveReferrerThread('', null)).toBeNull();
  });

  it('returns null when store thread is "default"', () => {
    expect(resolveReferrerThread('', 'default')).toBeNull();
  });

  it('prefers URL param over store thread', () => {
    expect(resolveReferrerThread('?from=url-thread', 'store-thread')).toBe('url-thread');
  });
});

describe('buildBackHref', () => {
  it('returns /thread/{id} for valid thread', () => {
    expect(buildBackHref('thread_abc')).toBe('/thread/thread_abc');
  });

  it('returns / when thread is null', () => {
    expect(buildBackHref(null)).toBe('/');
  });

  it('returns / when thread is "default"', () => {
    expect(buildBackHref('default')).toBe('/');
  });
});

describe('buildMemoryTabItems', () => {
  it('returns 4 tabs with correct ids', () => {
    const items = buildMemoryTabItems('');
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.id)).toEqual(['feed', 'search', 'status', 'health']);
  });

  it('includes fromSuffix in hrefs', () => {
    const items = buildMemoryTabItems('?from=thread_abc');
    expect(items[0].href).toBe('/memory?from=thread_abc');
    expect(items[1].href).toBe('/memory/search?from=thread_abc');
    expect(items[2].href).toBe('/memory/status?from=thread_abc');
    expect(items[3].href).toBe('/memory/health?from=thread_abc');
  });

  it('has correct labels', () => {
    const items = buildMemoryTabItems('');
    expect(items.map((i) => i.label)).toEqual(['Knowledge Feed', 'Search', 'Index Status', 'Health']);
  });

  it('MemoryTab type covers all tabs', () => {
    const tabs: MemoryTab[] = ['feed', 'search', 'status', 'health'];
    expect(tabs).toHaveLength(4);
  });
});
