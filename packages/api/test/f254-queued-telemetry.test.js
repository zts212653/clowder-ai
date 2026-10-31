import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const queuedTelemetry = await import('../dist/domains/cats/services/freshness/freshness-queue-telemetry.js');

describe('F254 D1.2 eval telemetry recorder', () => {
  beforeEach(() => {
    queuedTelemetry.resetFreshnessQueueTelemetryForTest();
  });

  it('records queued_seen transitions separately from queued_handled closures', () => {
    assert.deepEqual(queuedTelemetry.getFreshnessQueueTelemetrySnapshot(), {
      queuedSeenTotal: 0,
      queuedHandledTotal: 0,
      queuedHandledFullyConsumedTotal: 0,
    });

    queuedTelemetry.recordQueuedSeenTelemetry();
    queuedTelemetry.recordQueuedHandledTelemetry({ fullyConsumed: false });
    queuedTelemetry.recordQueuedHandledTelemetry({ fullyConsumed: true });

    assert.deepEqual(queuedTelemetry.getFreshnessQueueTelemetrySnapshot(), {
      queuedSeenTotal: 1,
      queuedHandledTotal: 2,
      queuedHandledFullyConsumedTotal: 1,
    });
  });
});
