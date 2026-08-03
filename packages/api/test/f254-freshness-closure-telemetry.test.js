import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const {
  getFreshnessClosureTelemetrySnapshot,
  recordFreshnessClosureTransition,
  recordFreshnessClosureStage,
  recordFreshnessReplayFence,
  recordFreshnessSuccessorPreflightCanceled,
  resetFreshnessClosureTelemetryForTest,
} = await import('../dist/domains/cats/services/freshness/freshness-closure-telemetry.js');

describe('F254 Phase E — closure eval telemetry', () => {
  beforeEach(() => resetFreshnessClosureTelemetryForTest());

  it('separates lifecycle transitions from redundant successor cancellation', () => {
    recordFreshnessClosureTransition('opened');
    recordFreshnessClosureTransition('superseded');
    recordFreshnessClosureTransition('committed');
    recordFreshnessReplayFence();
    recordFreshnessSuccessorPreflightCanceled('committed');
    recordFreshnessClosureStage('formal_committed');
    recordFreshnessClosureStage('preflight_blocked');

    assert.deepEqual(getFreshnessClosureTelemetrySnapshot(), {
      opened: 1,
      superseded: 1,
      committed: 1,
      blocked: 0,
      retried: 0,
      successorPreflightCanceledTotal: 1,
      replayFenceTotal: 1,
      formal_committed: 1,
      preflight_blocked: 1,
    });
  });
});
