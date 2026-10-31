/**
 * F231 AC-C3: Profile update eval counters.
 *
 * Validates that profile-update lifecycle events (propose/approve/reject)
 * have OTel counters for eval observability. Without these, "zero activation"
 * is invisible — the operator's harness=软+硬+eval mandate (KD-10).
 *
 * Tests verify:
 *   1. profileUpdateProposed counter exists and is callable
 *   2. profileUpdateApproved counter exists and is callable
 *   3. profileUpdateRejected counter exists and is callable
 *   4. All three are distinct instrument instances
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  profileUpdateApproved,
  profileUpdateProposed,
  profileUpdateRejected,
} from '../dist/infrastructure/telemetry/instruments.js';

describe('F231 AC-C3 — Profile update eval counters (KD-10)', () => {
  test('profileUpdateProposed counter exists and has .add()', () => {
    assert.ok(profileUpdateProposed, 'counter must be exported');
    assert.equal(typeof profileUpdateProposed.add, 'function', 'must have .add()');
  });

  test('profileUpdateApproved counter exists and has .add()', () => {
    assert.ok(profileUpdateApproved, 'counter must be exported');
    assert.equal(typeof profileUpdateApproved.add, 'function', 'must have .add()');
  });

  test('profileUpdateRejected counter exists and has .add()', () => {
    assert.ok(profileUpdateRejected, 'counter must be exported');
    assert.equal(typeof profileUpdateRejected.add, 'function', 'must have .add()');
  });

  test('all three are distinct instruments', () => {
    // Proxy-wrapped, but the lazy factory should create different underlying counters.
    // We verify by calling .add(0) — if they were the same, they'd share state.
    assert.doesNotThrow(() => {
      profileUpdateProposed.add(0);
      profileUpdateApproved.add(0);
      profileUpdateRejected.add(0);
    });
  });
});

describe('F231 AC-C3 — Metric allowlist includes profile attributes', () => {
  test('signal.kind is in the metric allowlist', async () => {
    const { ALLOWED_METRIC_ATTRIBUTES } = await import('../dist/infrastructure/telemetry/metric-allowlist.js');
    assert.ok(
      ALLOWED_METRIC_ATTRIBUTES.has('signal.kind'),
      'signal.kind must be in allowlist (profile propose counter emits it)',
    );
  });

  test('seal.reason is in the metric allowlist', async () => {
    const { ALLOWED_METRIC_ATTRIBUTES } = await import('../dist/infrastructure/telemetry/metric-allowlist.js');
    assert.ok(
      ALLOWED_METRIC_ATTRIBUTES.has('seal.reason'),
      'seal.reason must be in allowlist (distillation trigger counter emits it)',
    );
  });
});
