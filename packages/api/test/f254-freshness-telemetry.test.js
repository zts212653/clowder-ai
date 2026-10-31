/**
 * F254 AC-B5 — Freshness Telemetry Counters
 *
 * Tests that OTel counter instruments are properly defined and incrementable.
 * The gate, MCP-notice and re-invoke counters were retired with their producers;
 * what survives measures the provider-native notice and queue read/handled.
 *
 * [宪宪/Claude Opus 4.6🐾]
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Import from dist (consistent with other f254 tests)
const instruments = await import('../dist/infrastructure/telemetry/instruments.js');

describe('F254 AC-B5: Freshness telemetry counters', () => {
  it('exports Codex app-server lifecycle operational instruments', () => {
    for (const name of [
      'codexAppServerLifecycleTransition',
      'codexAppServerStageDuration',
      'codexAppServerRecovery',
      'codexAppServerInterrupt',
      'codexAppServerForcedCleanup',
    ]) {
      assert.ok(instruments[name], `${name} should be exported`);
    }
    assert.equal(typeof instruments.codexAppServerLifecycleTransition.add, 'function');
    assert.equal(typeof instruments.codexAppServerStageDuration.record, 'function');
    assert.equal(typeof instruments.codexAppServerRecovery.add, 'function');
    assert.equal(typeof instruments.codexAppServerInterrupt.add, 'function');
    assert.equal(typeof instruments.codexAppServerForcedCleanup.add, 'function');
  });

  // --- Counter existence tests ---

  it('exports queued read/handled closure counters', () => {
    assert.ok(instruments.freshnessQueuedSeen, 'freshnessQueuedSeen should be exported');
    assert.equal(typeof instruments.freshnessQueuedSeen.add, 'function', 'freshnessQueuedSeen should have add()');
    assert.ok(instruments.freshnessQueuedHandled, 'freshnessQueuedHandled should be exported');
    assert.equal(typeof instruments.freshnessQueuedHandled.add, 'function', 'freshnessQueuedHandled should have add()');
  });

  // --- Incrementability (no-throw) tests ---

  it('all freshness counters can be incremented without throwing', () => {
    // These should not throw even without a configured MeterProvider
    // (lazy proxy defers to NoopMeter)
    assert.doesNotThrow(() => instruments.freshnessProviderNotice.add(1));
    assert.doesNotThrow(() => instruments.freshnessQueuedSeen.add(1));
    assert.doesNotThrow(() => instruments.freshnessQueuedHandled.add(1));
  });

  // --- warmupCounters includes freshness counters ---

  it('warmupCounters does not throw (freshness counters pre-touched)', () => {
    assert.doesNotThrow(() => instruments.warmupCounters());
  });
});
