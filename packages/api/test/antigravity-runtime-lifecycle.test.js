import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ANTIGRAVITY_RUNTIME_SEAL_REASONS,
  buildAntigravitySessionLifecycle,
  normalizeAntigravitySessionLifecycle,
} from '../dist/domains/cats/services/agents/providers/antigravity/antigravity-runtime-lifecycle.js';

const EXPECTED_REASONS = [
  'oversized_retire',
  'user_initiated',
  'model_capacity',
  'empty_response',
  'stream_error',
  'tool_conflict',
  'unsafe_side_effect',
  'runtime_disconnected',
  'runtime_error_reset',
];

describe('Antigravity runtime lifecycle carrier', () => {
  test('defines every F211 A2 Antigravity runtime seal reason', () => {
    assert.deepEqual([...ANTIGRAVITY_RUNTIME_SEAL_REASONS].sort(), [...EXPECTED_REASONS].sort());
  });

  test('rejects unknown seal reasons', () => {
    assert.throws(
      () =>
        normalizeAntigravitySessionLifecycle({
          runtime: 'antigravity-desktop',
          runtimeSessionId: 'cascade-1',
          sealReason: 'mystery_rotation',
        }),
      /invalid antigravity runtime seal reason/,
    );
  });

  test('builds lifecycle payload for same-cascade observation', () => {
    const lifecycle = buildAntigravitySessionLifecycle({
      runtimeSessionId: 'cascade-1',
    });

    assert.equal(lifecycle.runtime, 'antigravity-desktop');
    assert.equal(lifecycle.runtimeSessionId, 'cascade-1');
    assert.equal(lifecycle.previousRuntimeSessionId, undefined);
    assert.equal(lifecycle.sealReason, undefined);
    assert.equal(lifecycle.degraded, undefined);
  });

  test('builds lifecycle payload for automatic rotation', () => {
    const lifecycle = buildAntigravitySessionLifecycle({
      runtimeSessionId: 'cascade-new',
      previousRuntimeSessionId: 'cascade-old',
      sealReason: 'stream_error',
      drainResult: 'best_effort_quiet_window',
    });

    assert.equal(lifecycle.runtime, 'antigravity-desktop');
    assert.equal(lifecycle.runtimeSessionId, 'cascade-new');
    assert.equal(lifecycle.previousRuntimeSessionId, 'cascade-old');
    assert.equal(lifecycle.sealReason, 'stream_error');
    assert.equal(lifecycle.drainResult, 'best_effort_quiet_window');
  });

  test('normalizes pending/degraded lifecycle payload', () => {
    const lifecycle = normalizeAntigravitySessionLifecycle({
      runtime: 'antigravity-desktop',
      runtimeSessionId: 'cascade-new',
      previousRuntimeSessionId: 'cascade-old',
      sealReason: 'runtime_disconnected',
      drainResult: 'skipped_runtime_unreachable',
      degraded: true,
      degradedReason: 'runtime not reachable during drain',
      continuityBootstrapId: 'bootstrap-1',
    });

    assert.equal(lifecycle.degraded, true);
    assert.equal(lifecycle.degradedReason, 'runtime not reachable during drain');
    assert.equal(lifecycle.continuityBootstrapId, 'bootstrap-1');
  });
});
