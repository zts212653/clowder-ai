import { describe, expect, it } from 'vitest';
import {
  computeBarWidth,
  computeDonutSegments,
  getActionItems,
  type HealthReportData,
  sortedEntries,
} from '../HealthReport';

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
    expect(items.some((i) => i.includes('constitutional'))).toBe(true);
  });

  it('flags unresolved contradictions', () => {
    const items = getActionItems({ ...baseReport, contradictions: { total: 3, unresolved: 2 } });
    expect(items.some((i) => i.includes('contradiction'))).toBe(true);
  });

  it('flags overdue reviews', () => {
    const items = getActionItems({ ...baseReport, staleReview: { warning: 1, overdue: 3 } });
    expect(items.some((i) => i.includes('overdue'))).toBe(true);
  });

  it('returns empty when everything is healthy', () => {
    const healthy: HealthReportData = {
      ...baseReport,
      byAuthority: { observed: 100, candidate: 50, validated: 30, constitutional: 20 },
    };
    const items = getActionItems(healthy);
    expect(items.some((i) => i.includes('constitutional'))).toBe(false);
  });
});
