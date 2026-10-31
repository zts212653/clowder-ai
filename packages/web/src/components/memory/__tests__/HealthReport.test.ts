import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import {
  computeBarWidth,
  computeDonutSegments,
  getActionItems,
  type HealthReportData,
  sortedEntries,
} from '../HealthReport';

Object.assign(globalThis as Record<string, unknown>, { React });

describe('sortedEntries', () => {
  it('sorts by value descending', () => {
    const result = sortedEntries({ plan: 235, thread: 633, feature: 167 });
    expect(result).toEqual([
      ['thread', 633],
      ['plan', 235],
      ['feature', 167],
    ]);
  });

  it('returns empty array for empty object', () => {
    expect(sortedEntries({})).toEqual([]);
  });
});

describe('computeBarWidth', () => {
  it('returns 100 for max value', () => {
    expect(computeBarWidth(633, 633)).toBe(100);
  });

  it('returns proportional percentage', () => {
    expect(computeBarWidth(235, 633)).toBeCloseTo(37.1, 0);
  });

  it('returns 0 when max is 0', () => {
    expect(computeBarWidth(0, 0)).toBe(0);
  });
});

describe('computeDonutSegments', () => {
  const RADIUS = 40;
  const C = 2 * Math.PI * RADIUS;

  it('computes cumulative prefix-sum offsets', () => {
    const segments = computeDonutSegments(
      ['observed', 'candidate', 'validated', 'constitutional'],
      { observed: 70, candidate: 20, validated: 10 },
      100,
      RADIUS,
    );

    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({ level: 'observed', offset: 0 });
    expect(segments[1].level).toBe('candidate');
    expect(segments[1].offset).toBeCloseTo(0.7 * C, 5);
    expect(segments[2].level).toBe('validated');
    expect(segments[2].offset).toBeCloseTo(0.9 * C, 5);
  });

  it('skips zero-count levels', () => {
    const segments = computeDonutSegments(['a', 'b', 'c'], { a: 50, c: 50 }, 100, RADIUS);
    expect(segments).toHaveLength(2);
    expect(segments[0].level).toBe('a');
    expect(segments[1].level).toBe('c');
    expect(segments[1].offset).toBeCloseTo(0.5 * C, 5);
  });

  it('returns empty when total is 0', () => {
    expect(computeDonutSegments(['a'], {}, 0, RADIUS)).toEqual([]);
  });
});

describe('getActionItems', () => {
  const baseReport: HealthReportData = {
    totalDocs: 1463,
    byKind: { thread: 633 },
    byAuthority: { observed: 1463 },
    contradictions: { total: 0, unresolved: 0 },
    staleReview: { warning: 0, overdue: 0 },
    unverified: 0,
    backstopRatio: 0,
    compressionRatio: 0,
    generatedAt: '2026-04-16T00:00:00Z',
  };

  it('suggests seeding when all docs are observed', () => {
    const items = getActionItems(baseReport);
    expect(items.some((i) => i.includes('宪法播种'))).toBe(true);
  });

  it('flags unresolved contradictions', () => {
    const items = getActionItems({ ...baseReport, contradictions: { total: 3, unresolved: 2 } });
    expect(items.some((i) => i.includes('未解决矛盾'))).toBe(true);
  });

  it('flags overdue reviews', () => {
    const items = getActionItems({ ...baseReport, staleReview: { warning: 1, overdue: 3 } });
    expect(items.some((i) => i.includes('逾期'))).toBe(true);
  });

  it('returns empty when everything is healthy', () => {
    const healthy: HealthReportData = {
      ...baseReport,
      byAuthority: { observed: 100, candidate: 50, validated: 30, constitutional: 20 },
    };
    const items = getActionItems(healthy);
    expect(items.some((i) => i.includes('宪法播种'))).toBe(false);
  });

  it('flags stale anchors', () => {
    const items = getActionItems({
      ...baseReport,
      staleAnchors: { count: 3, items: [] },
    });
    expect(items.some((i) => i.includes('过期锚点'))).toBe(true);
  });

  it('flags orphan edges', () => {
    const items = getActionItems({
      ...baseReport,
      orphanEdges: { count: 5 },
    });
    expect(items.some((i) => i.includes('孤立边'))).toBe(true);
  });

  it('flags knowledge feed pending', () => {
    const items = getActionItems({
      ...baseReport,
      knowledgeFeed: { pendingCount: 7, needsReviewCount: 2 },
    });
    expect(items.some((i) => i.includes('待处理知识动态'))).toBe(true);
  });
});

describe('HealthReport render', () => {
  it('includes Eval Hub backlink', async () => {
    vi.mock('@/utils/api-client', () => ({
      apiFetch: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            totalDocs: 100,
            byKind: { thread: 50 },
            byAuthority: { observed: 80, constitutional: 20 },
            contradictions: { total: 0, unresolved: 0 },
            staleReview: { warning: 0, overdue: 0 },
            unverified: 0,
            backstopRatio: 0,
            compressionRatio: 0,
            generatedAt: '2026-05-24T00:00:00Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    }));

    const { HealthReport } = await import('../HealthReport');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(HealthReport));
    });
    await act(async () => {
      await Promise.resolve();
    });

    const backlink = container.querySelector('[data-testid="eval-hub-backlink"]') as HTMLAnchorElement | null;
    expect(backlink).toBeTruthy();
    expect(backlink?.getAttribute('href')).toBe('/settings?ops=observability&obs=eval');
    expect(backlink?.textContent).toContain('Eval Hub');

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });
});
