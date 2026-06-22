import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { shouldSpawnNarratorForCase } = await import('../dist/domains/community/community-narrator-eligibility.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BOOTSTRAP_AT = 1_700_000_000_000; // some past timestamp
const LATER_ACTIVITY = BOOTSTRAP_AT + 86_400_000; // +1 day

// ---------------------------------------------------------------------------
// D0.1 narrator eligibility gate — INV-D0.1 / INV-D0.2 / INV-D0.3
// ---------------------------------------------------------------------------

describe('shouldSpawnNarratorForCase', () => {
  // INV-D0.1: auto path must NOT spawn narrator for pure bootstrap legacy cases
  test('bootstrap + no wake-worthy activity + auto-reconciler → blocked', () => {
    const result = shouldSpawnNarratorForCase({
      triggerSource: 'auto-reconciler',
      lastWakeActivityAt: null,
      bootstrapAt: BOOTSTRAP_AT,
    });
    assert.deepStrictEqual(result, { ok: false, reason: 'legacy-bootstrap' });
  });

  // INV-D0.2: manual dispatch still works for legacy cases
  test('bootstrap + no wake-worthy activity + manual → allowed', () => {
    const result = shouldSpawnNarratorForCase({
      triggerSource: 'manual',
      lastWakeActivityAt: null,
      bootstrapAt: BOOTSTRAP_AT,
    });
    assert.deepStrictEqual(result, { ok: true });
  });

  // INV-D0.3: new wake-worthy external activity unfreezes legacy cases for auto path
  test('bootstrap + later wake-worthy activity + auto-reconciler → allowed', () => {
    const result = shouldSpawnNarratorForCase({
      triggerSource: 'auto-reconciler',
      lastWakeActivityAt: LATER_ACTIVITY,
      bootstrapAt: BOOTSTRAP_AT,
    });
    assert.deepStrictEqual(result, { ok: true });
  });

  // Fresh (non-bootstrap) case — always allowed regardless of trigger source
  test('non-bootstrap fresh case + auto-reconciler → allowed', () => {
    const result = shouldSpawnNarratorForCase({
      triggerSource: 'auto-reconciler',
      lastWakeActivityAt: LATER_ACTIVITY,
      bootstrapAt: null,
    });
    assert.deepStrictEqual(result, { ok: true });
  });

  // Edge: no activity and no bootstrap — treat as fresh
  test('null activity + null bootstrap + auto-reconciler → allowed', () => {
    const result = shouldSpawnNarratorForCase({
      triggerSource: 'auto-reconciler',
      lastWakeActivityAt: null,
      bootstrapAt: null,
    });
    assert.deepStrictEqual(result, { ok: true });
  });

  // Edge: bootstrap exists but no wake-worthy activity recorded — fail-closed for auto
  // (P2 砚砚 R1: safety-critical branch must be pinned by test)
  test('bootstrap + no wake-worthy activity + auto-reconciler → blocked (fail-closed)', () => {
    const result = shouldSpawnNarratorForCase({
      triggerSource: 'auto-reconciler',
      lastWakeActivityAt: null,
      bootstrapAt: BOOTSTRAP_AT,
    });
    assert.deepStrictEqual(result, { ok: false, reason: 'legacy-bootstrap' });
  });

  // Edge: bootstrap case where wake-worthy activity === bootstrapAt
  // (activity AT bootstrap time, not AFTER) — should block auto
  test('bootstrap + wake activity at same timestamp as bootstrap + auto → blocked', () => {
    const result = shouldSpawnNarratorForCase({
      triggerSource: 'auto-reconciler',
      lastWakeActivityAt: BOOTSTRAP_AT,
      bootstrapAt: BOOTSTRAP_AT,
    });
    assert.deepStrictEqual(result, { ok: false, reason: 'legacy-bootstrap' });
  });
});
