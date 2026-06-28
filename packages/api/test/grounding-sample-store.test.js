/**
 * F167 Phase O PR-O2b: Bounded Sample Store Tests
 *
 * Sampling rules (spec R2 + R3):
 * - mismatch & wouldBlock: 100% keep
 * - insufficient: cap 3 per resolver×thread×day
 * - verified: 1/20 rate + global daily cap
 *
 * TDD: RED phase — define expected sampling behavior.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

const { GroundingSampleStore } = await import('../dist/infrastructure/grounding/grounding-sample-store.js');

/** @returns {import('../dist/infrastructure/grounding/types.js').ClaimGroundingEvent} */
function makeEvent(overrides = {}) {
  return {
    invocationId: 'inv-1',
    catId: 'opus',
    threadId: 'thread-1',
    claimType: 'object',
    sourceKind: 'self',
    sourceRef: { kind: 'pr_url', value: 'org/repo#1' },
    resolver: 'github_pr',
    resolverSourceTier: 'T1',
    cacheHit: false,
    verdict: 'verified',
    actionFamily: 'register_tracking',
    actionRisk: 'register_tracking',
    tool: 'register_pr_tracking',
    ts: Date.now(),
    resolverCallsRemaining: 5,
    ...overrides,
  };
}

describe('GroundingSampleStore', () => {
  /** @type {import('../dist/infrastructure/grounding/grounding-sample-store.js').GroundingSampleStore} */
  let store;

  beforeEach(() => {
    store = new GroundingSampleStore();
  });

  // ── Mismatch: 100% keep ──────────────────────────────────

  test('mismatch events are always stored', () => {
    for (let i = 0; i < 10; i++) {
      store.record(makeEvent({ verdict: 'mismatch', invocationId: `inv-${i}` }), false);
    }
    assert.equal(store.getSamples().length, 10);
  });

  test('wouldBlock events are always stored regardless of verdict', () => {
    for (let i = 0; i < 10; i++) {
      store.record(
        makeEvent({ verdict: 'insufficient', invocationId: `inv-${i}` }),
        true, // wouldBlock
      );
    }
    assert.equal(store.getSamples().length, 10);
  });

  // ── Insufficient: cap 3 per resolver×thread×day ──────────

  test('insufficient events capped at 3 per resolver×thread×day', () => {
    const baseTs = new Date('2026-06-20T00:00:00Z').getTime();
    for (let i = 0; i < 10; i++) {
      store.record(
        makeEvent({
          verdict: 'insufficient',
          resolver: 'github_pr',
          threadId: 'thread-A',
          invocationId: `inv-${i}`,
          ts: baseTs + i * 1000,
        }),
        false,
      );
    }
    const samples = store
      .getSamples()
      .filter((e) => e.verdict === 'insufficient' && e.resolver === 'github_pr' && e.threadId === 'thread-A');
    assert.equal(samples.length, 3);
  });

  test('insufficient cap is per-resolver: different resolvers have separate caps', () => {
    const baseTs = new Date('2026-06-20T00:00:00Z').getTime();
    for (let i = 0; i < 5; i++) {
      store.record(
        makeEvent({
          verdict: 'insufficient',
          resolver: 'resolver_A',
          threadId: 'thread-1',
          invocationId: `inv-A-${i}`,
          ts: baseTs + i * 1000,
        }),
        false,
      );
      store.record(
        makeEvent({
          verdict: 'insufficient',
          resolver: 'resolver_B',
          threadId: 'thread-1',
          invocationId: `inv-B-${i}`,
          ts: baseTs + i * 1000,
        }),
        false,
      );
    }
    const samplesA = store.getSamples().filter((e) => e.resolver === 'resolver_A');
    const samplesB = store.getSamples().filter((e) => e.resolver === 'resolver_B');
    assert.equal(samplesA.length, 3);
    assert.equal(samplesB.length, 3);
  });

  test('insufficient cap is per-thread: different threads have separate caps', () => {
    const baseTs = new Date('2026-06-20T00:00:00Z').getTime();
    for (let i = 0; i < 5; i++) {
      store.record(
        makeEvent({
          verdict: 'insufficient',
          resolver: 'github_pr',
          threadId: 'thread-X',
          invocationId: `inv-X-${i}`,
          ts: baseTs + i * 1000,
        }),
        false,
      );
      store.record(
        makeEvent({
          verdict: 'insufficient',
          resolver: 'github_pr',
          threadId: 'thread-Y',
          invocationId: `inv-Y-${i}`,
          ts: baseTs + i * 1000,
        }),
        false,
      );
    }
    const samplesX = store.getSamples().filter((e) => e.threadId === 'thread-X');
    const samplesY = store.getSamples().filter((e) => e.threadId === 'thread-Y');
    assert.equal(samplesX.length, 3);
    assert.equal(samplesY.length, 3);
  });

  test('insufficient cap resets on new day', () => {
    const day1 = new Date('2026-06-20T12:00:00Z').getTime();
    const day2 = new Date('2026-06-21T12:00:00Z').getTime();

    // Fill cap on day 1
    for (let i = 0; i < 5; i++) {
      store.record(
        makeEvent({
          verdict: 'insufficient',
          resolver: 'github_pr',
          threadId: 'thread-1',
          invocationId: `inv-d1-${i}`,
          ts: day1 + i * 1000,
        }),
        false,
      );
    }

    // Day 2 should allow 3 more
    for (let i = 0; i < 5; i++) {
      store.record(
        makeEvent({
          verdict: 'insufficient',
          resolver: 'github_pr',
          threadId: 'thread-1',
          invocationId: `inv-d2-${i}`,
          ts: day2 + i * 1000,
        }),
        false,
      );
    }

    const samples = store.getSamples().filter((e) => e.verdict === 'insufficient');
    assert.equal(samples.length, 6); // 3 from day 1 + 3 from day 2
  });

  // ── Verified: 1/20 rate + daily cap ──────────────────────

  test('verified events sampled at ~1/20 rate', () => {
    // Deterministic: use injectable sampler
    let callCount = 0;
    const deterministicStore = new GroundingSampleStore({
      verifiedSampleRate: 20,
      verifiedDailyCap: 100,
      // Deterministic: sample every 20th
      shouldSampleVerified: () => ++callCount % 20 === 0,
    });

    for (let i = 0; i < 100; i++) {
      deterministicStore.record(
        makeEvent({
          verdict: 'verified',
          invocationId: `inv-${i}`,
          ts: Date.now(),
        }),
        false,
      );
    }

    const samples = deterministicStore.getSamples().filter((e) => e.verdict === 'verified');
    assert.equal(samples.length, 5); // 100 / 20 = 5
  });

  test('verified daily cap enforced', () => {
    const dailyStore = new GroundingSampleStore({
      verifiedDailyCap: 3,
      shouldSampleVerified: () => true, // always sample
    });

    for (let i = 0; i < 10; i++) {
      dailyStore.record(
        makeEvent({
          verdict: 'verified',
          invocationId: `inv-${i}`,
          ts: Date.now(),
        }),
        false,
      );
    }

    const samples = dailyStore.getSamples().filter((e) => e.verdict === 'verified');
    assert.equal(samples.length, 3);
  });

  // ── getSamples ─────────────────────────────────────────────

  test('getSamples returns stored events in insertion order', () => {
    store.record(makeEvent({ invocationId: 'first', verdict: 'mismatch' }), false);
    store.record(makeEvent({ invocationId: 'second', verdict: 'mismatch' }), false);
    const samples = store.getSamples();
    assert.equal(samples[0].invocationId, 'first');
    assert.equal(samples[1].invocationId, 'second');
  });

  test('getSamples returns a defensive copy', () => {
    store.record(makeEvent({ verdict: 'mismatch' }), false);
    const a = store.getSamples();
    const b = store.getSamples();
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
  });

  // ── Total capacity ─────────────────────────────────────────

  test('store enforces global max capacity', () => {
    const smallStore = new GroundingSampleStore({ maxTotal: 5 });
    for (let i = 0; i < 10; i++) {
      smallStore.record(makeEvent({ verdict: 'mismatch', invocationId: `inv-${i}` }), false);
    }
    assert.equal(smallStore.getSamples().length, 5);
  });

  // ── Stats ──────────────────────────────────────────────────

  test('getStats returns sampling statistics', () => {
    // Use deterministic store so verified always samples
    const detStore = new GroundingSampleStore({ shouldSampleVerified: () => true });
    detStore.record(makeEvent({ verdict: 'mismatch' }), false);
    detStore.record(makeEvent({ verdict: 'verified' }), false);
    detStore.record(makeEvent({ verdict: 'insufficient' }), false);
    const stats = detStore.getStats();
    assert.equal(stats.stored, 3);
    assert.equal(typeof stats.dropped, 'number');
  });
});
