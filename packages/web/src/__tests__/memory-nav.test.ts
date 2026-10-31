/**
 * F102 Phase J: MemoryNav logic tests
 *
 * Tests referrer thread resolution, back href, and tab config generation.
 * Same pattern as SignalNav but for /memory route.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HealthReportData } from '@/components/memory/HealthReport';
import {
  buildBackHref,
  buildMemoryTabItems,
  MemoryNav,
  type MemoryTab,
  resolveReferrerThread,
} from '@/components/memory/MemoryNav';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({ ok: false })),
}));

function mockHealthReport(overrides: Partial<HealthReportData> = {}): HealthReportData {
  return {
    totalDocs: 100,
    byKind: {},
    byAuthority: {},
    contradictions: { total: 0, unresolved: 0 },
    staleReview: { warning: 0, overdue: 0 },
    unverified: 0,
    backstopRatio: 0,
    compressionRatio: 0,
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

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
  it('returns 6 tabs with correct ids', () => {
    const items = buildMemoryTabItems('');
    expect(items).toHaveLength(6);
    expect(items.map((i) => i.id)).toEqual(['feed', 'search', 'status', 'health', 'catalog', 'graph']);
  });

  it('includes fromSuffix in hrefs', () => {
    const items = buildMemoryTabItems('?from=thread_abc');
    expect(items[0].href).toBe('/memory?from=thread_abc');
    expect(items[1].href).toBe('/memory/search?from=thread_abc');
    expect(items[2].href).toBe('/memory/status?from=thread_abc');
    expect(items[3].href).toBe('/memory/health?from=thread_abc');
    expect(items[4].href).toBe('/memory/catalog?from=thread_abc');
    expect(items[5].href).toBe('/memory/graph?from=thread_abc');
  });

  it('has correct labels', () => {
    const items = buildMemoryTabItems('');
    expect(items.map((i) => i.label)).toEqual(['知识动态', '搜索', '索引状态', '健康度', '图书馆', '知识图谱']);
  });

  it('MemoryTab type covers all tabs', () => {
    const tabs: MemoryTab[] = ['feed', 'search', 'status', 'health', 'catalog', 'graph'];
    expect(tabs).toHaveLength(6);
  });

  it('attaches badge count for specified tabs', () => {
    const items = buildMemoryTabItems('', { health: 3 });
    const healthTab = items.find((i) => i.id === 'health');
    expect(healthTab?.badge).toBe(3);
  });

  it('omits badge when count is 0', () => {
    const items = buildMemoryTabItems('', { health: 0 });
    const healthTab = items.find((i) => i.id === 'health');
    expect(healthTab?.badge).toBeUndefined();
  });

  it('leaves tabs without badge entry unchanged', () => {
    const items = buildMemoryTabItems('', { health: 5 });
    const feedTab = items.find((i) => i.id === 'feed');
    expect(feedTab?.badge).toBeUndefined();
  });
});

describe('MemoryNav component', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('updates referrer links when the initial referrer changes', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(MemoryNav, { active: 'graph', initialReferrerThread: 'thread_a' }));
    });
    const graphLinkA = Array.from(container.querySelectorAll('a')).find((a) => a.textContent === '知识图谱');
    expect(graphLinkA?.getAttribute('href')).toContain('?from=thread_a');

    await act(async () => {
      root.render(createElement(MemoryNav, { active: 'graph', initialReferrerThread: 'thread_b' }));
    });

    const graphLinkB = Array.from(container.querySelectorAll('a')).find((a) => a.textContent === '知识图谱');
    expect(graphLinkB?.getAttribute('href')).toContain('?from=thread_b');
    expect(container.textContent).toContain('知识图谱');

    root.unmount();
    container.remove();
  });

  it('renders health badge when report has action items (P1 cloud R5)', async () => {
    const { apiFetch } = await import('@/utils/api-client');
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockHealthReport({ staleAnchors: { count: 3, items: [] }, orphanEdges: { count: 2 } }),
    } as Response);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(MemoryNav, { active: 'feed' }));
    });

    const badge = container.querySelector('[data-testid="health-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('3');

    root.unmount();
    container.remove();
  });

  it('does not render badge when no health issues', async () => {
    const { apiFetch } = await import('@/utils/api-client');
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockHealthReport({ byAuthority: { constitutional: 1 } }),
    } as Response);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(MemoryNav, { active: 'feed' }));
    });

    expect(container.querySelector('[data-testid="health-badge"]')).toBeNull();

    root.unmount();
    container.remove();
  });
});
