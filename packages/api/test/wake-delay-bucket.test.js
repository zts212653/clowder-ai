/**
 * F192 Phase D — eval:a2a 2026-06-12 build verdict: wake-delay bucket classification.
 *
 * Locks the boundary discipline so attribution / dashboards reading C1 zombie-hold
 * sample triggers can rely on a stable, mechanical categorization.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { bucketWakeDelay, WAKE_DELAY_BUCKETS } = await import('../dist/routes/wake-delay-bucket.js');

describe('F192 D bucketWakeDelay (eval:a2a 2026-06-12 C1 zombie-hold trigger taxonomy)', () => {
  test('exports a stable, ordered bucket id list', () => {
    assert.deepEqual([...WAKE_DELAY_BUCKETS], ['prior_overdue', 'prior_imminent', 'prior_short', 'prior_long']);
  });

  test('prior_overdue: prior.fireAt is in the past', () => {
    const now = 1_700_000_000_000;
    assert.equal(bucketWakeDelay(now - 1, now), 'prior_overdue');
    assert.equal(bucketWakeDelay(now - 10_000, now), 'prior_overdue');
    assert.equal(bucketWakeDelay(now - 600_000, now), 'prior_overdue');
  });

  test('prior_imminent: 0 ≤ delta < 60_000ms', () => {
    const now = 1_700_000_000_000;
    // Boundary case: delta = 0 attributes to imminent (overdue is strict <)
    assert.equal(bucketWakeDelay(now, now), 'prior_imminent');
    assert.equal(bucketWakeDelay(now + 1, now), 'prior_imminent');
    assert.equal(bucketWakeDelay(now + 30_000, now), 'prior_imminent');
    assert.equal(bucketWakeDelay(now + 59_999, now), 'prior_imminent');
  });

  test('prior_short: 60_000 ≤ delta < 300_000ms (1-5min)', () => {
    const now = 1_700_000_000_000;
    // Boundary case: delta = 60000 attributes to short (imminent is strict <)
    assert.equal(bucketWakeDelay(now + 60_000, now), 'prior_short');
    assert.equal(bucketWakeDelay(now + 120_000, now), 'prior_short');
    assert.equal(bucketWakeDelay(now + 299_999, now), 'prior_short');
  });

  test('prior_long: delta ≥ 300_000ms (≥ 5min)', () => {
    const now = 1_700_000_000_000;
    // Boundary case: delta = 300000 attributes to long (short is strict <)
    assert.equal(bucketWakeDelay(now + 300_000, now), 'prior_long');
    assert.equal(bucketWakeDelay(now + 600_000, now), 'prior_long');
    assert.equal(bucketWakeDelay(now + 3_600_000, now), 'prior_long');
  });

  test('classification covers every bucket without overlap', () => {
    // Sweep across the 4 boundaries to assert the partitioning is total + disjoint
    const now = 1_000_000;
    const samples = [-1, 0, 59_999, 60_000, 299_999, 300_000];
    const expected = ['prior_overdue', 'prior_imminent', 'prior_imminent', 'prior_short', 'prior_short', 'prior_long'];
    samples.forEach((delta, i) => {
      assert.equal(bucketWakeDelay(now + delta, now), expected[i], `delta=${delta} should be ${expected[i]}`);
    });
  });
});
