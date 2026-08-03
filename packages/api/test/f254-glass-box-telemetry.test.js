import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const {
  getFreshnessGlassBoxTelemetrySnapshot,
  recordFreshnessGlassBoxTransition,
  resetFreshnessGlassBoxTelemetryForTest,
} = await import('../dist/domains/cats/services/freshness/glass-box/freshness-glass-box-telemetry.js');

describe('F254 ADR-042 glass-box telemetry', () => {
  beforeEach(() => resetFreshnessGlassBoxTelemetryForTest());

  it('separates publication from supplement offer, production, and decline', () => {
    recordFreshnessGlassBoxTransition('published_with_unseen');
    recordFreshnessGlassBoxTransition('supplement_offered');
    recordFreshnessGlassBoxTransition('supplement_produced');
    recordFreshnessGlassBoxTransition('supplement_declined');
    recordFreshnessGlassBoxTransition('supplement_decline_protocol_recovered');

    assert.deepEqual(getFreshnessGlassBoxTelemetrySnapshot(), {
      published_with_unseen: 1,
      supplement_offered: 1,
      supplement_produced: 1,
      supplement_declined: 1,
      supplement_decline_protocol_recovered: 1,
    });
  });
});
