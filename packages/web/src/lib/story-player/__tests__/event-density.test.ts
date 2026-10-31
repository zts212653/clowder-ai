/**
 * F252 Phase E PR E-2 — Event Density Computation Tests
 *
 * Tests the pure function that computes event density across
 * timeline buckets for the heatmap overlay (AC-E7 partial).
 */

import { describe, expect, it } from 'vitest';
import { computeEventDensity } from '../event-density';

describe('F252 event density — computeEventDensity', () => {
  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('returns empty array for empty events', () => {
    expect(computeEventDensity([], 10)).toEqual([]);
  });

  it('returns empty array for single event', () => {
    // Single event has no timeline span → can't compute density
    expect(computeEventDensity([{ timestamp: 100 }], 10)).toEqual([]);
  });

  it('returns empty array for bucketCount <= 0', () => {
    const events = [{ timestamp: 0 }, { timestamp: 100 }];
    expect(computeEventDensity(events, 0)).toEqual([]);
    expect(computeEventDensity(events, -5)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Basic density computation
  // ---------------------------------------------------------------------------

  it('distributes evenly spaced events across buckets', () => {
    // 10 events spaced 100ms apart → 0, 100, 200, ..., 900
    const events = Array.from({ length: 10 }, (_, i) => ({ timestamp: i * 100 }));
    const buckets = computeEventDensity(events, 5);

    expect(buckets).toHaveLength(5);
    // Each bucket covers 180ms (900/5). Events should be roughly evenly distributed.
    // All buckets should have similar density → all normalized close to 1.0
    for (const b of buckets) {
      expect(b.density).toBeGreaterThan(0);
    }
  });

  it('concentrates density in the correct bucket for clustered events', () => {
    // 10 events clustered at t=0, one event at t=1000
    const events = [...Array.from({ length: 10 }, () => ({ timestamp: 0 })), { timestamp: 1000 }];
    const buckets = computeEventDensity(events, 5);

    expect(buckets).toHaveLength(5);
    // First bucket should be the densest (normalized to 1.0)
    expect(buckets[0].density).toBe(1.0);
    // Last bucket has just 1 event → lower density
    expect(buckets[buckets.length - 1].density).toBeLessThan(1.0);
  });

  it('normalizes density to [0, 1] range', () => {
    const events = [{ timestamp: 0 }, { timestamp: 100 }, { timestamp: 200 }, { timestamp: 500 }, { timestamp: 1000 }];
    const buckets = computeEventDensity(events, 10);

    for (const b of buckets) {
      expect(b.density).toBeGreaterThanOrEqual(0);
      expect(b.density).toBeLessThanOrEqual(1.0);
    }
    // At least one bucket should have density 1.0 (the maximum)
    const maxDensity = Math.max(...buckets.map((b) => b.density));
    expect(maxDensity).toBe(1.0);
  });

  // ---------------------------------------------------------------------------
  // Bucket count variations
  // ---------------------------------------------------------------------------

  it('respects requested bucket count', () => {
    const events = [{ timestamp: 0 }, { timestamp: 100 }, { timestamp: 200 }];
    expect(computeEventDensity(events, 3)).toHaveLength(3);
    expect(computeEventDensity(events, 7)).toHaveLength(7);
    expect(computeEventDensity(events, 1)).toHaveLength(1);
  });

  it('single bucket has density 1.0', () => {
    const events = [{ timestamp: 0 }, { timestamp: 100 }, { timestamp: 200 }];
    const buckets = computeEventDensity(events, 1);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].density).toBe(1.0);
  });

  // ---------------------------------------------------------------------------
  // Index-based bucketing (coordinate alignment with progress bar)
  // ---------------------------------------------------------------------------

  it('produces zero-density buckets where no events are assigned', () => {
    // 2 events with 10 buckets → only 2 buckets get events, rest are empty
    const events = [{ timestamp: 0 }, { timestamp: 10000 }];
    const buckets = computeEventDensity(events, 10);
    expect(buckets).toHaveLength(10);

    // Exactly 2 buckets should have density > 0, rest should be 0
    const nonZero = buckets.filter((b) => b.density > 0);
    const zero = buckets.filter((b) => b.density === 0);
    expect(nonZero.length).toBe(2);
    expect(zero.length).toBe(8);
  });

  it('shows high density for rapid-fire events and low for idle gaps', () => {
    // 5 events rapid (0-4ms), then 5 events slow (1000-5000ms)
    const events = [
      { timestamp: 0 },
      { timestamp: 1 },
      { timestamp: 2 },
      { timestamp: 3 },
      { timestamp: 4 },
      { timestamp: 1000 },
      { timestamp: 2000 },
      { timestamp: 3000 },
      { timestamp: 4000 },
      { timestamp: 5000 },
    ];
    const buckets = computeEventDensity(events, 2);
    expect(buckets).toHaveLength(2);

    // First bucket (rapid events) should be much denser than second (idle gap)
    expect(buckets[0].density).toBe(1.0); // max rate = rapid fire
    expect(buckets[1].density).toBeLessThan(0.01); // slow = very low rate
  });

  // ---------------------------------------------------------------------------
  // Determinism
  // ---------------------------------------------------------------------------

  it('produces identical results for identical input', () => {
    const events = [{ timestamp: 0 }, { timestamp: 500 }, { timestamp: 750 }, { timestamp: 1000 }];
    const a = computeEventDensity(events, 5);
    const b = computeEventDensity(events, 5);
    expect(a).toEqual(b);
  });

  // ---------------------------------------------------------------------------
  // Non-sorted input
  // ---------------------------------------------------------------------------

  it('handles unsorted timestamps correctly', () => {
    const sorted = [{ timestamp: 0 }, { timestamp: 500 }, { timestamp: 1000 }];
    const unsorted = [{ timestamp: 500 }, { timestamp: 1000 }, { timestamp: 0 }];
    const a = computeEventDensity(sorted, 5);
    const b = computeEventDensity(unsorted, 5);
    expect(a).toEqual(b);
  });
});
