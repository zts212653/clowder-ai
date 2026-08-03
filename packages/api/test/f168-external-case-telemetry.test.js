import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('F168 external case telemetry instruments', () => {
  it('exports activation, zero-tolerance, and latency instruments', async () => {
    const instruments = await import('../dist/infrastructure/telemetry/instruments.js');
    for (const name of [
      'externalCaseHeadObserved',
      'externalCaseVerdictRecorded',
      'externalCaseReviewerWakeDelivered',
      'externalCaseVerdictReadyWithoutDelivery',
      'externalCaseNoisyWakeDuringCloudReview',
      'externalCaseDuplicateReviewerWakePerHead',
      'externalCaseUserNudgeRequired',
    ]) {
      assert.equal(typeof instruments[name]?.add, 'function', `${name} must be an incrementable counter`);
    }
    assert.equal(typeof instruments.externalCasePendingDeliveryAgeSeconds?.record, 'function');
    assert.equal(typeof instruments.externalCaseAuthorUpdateToReadyWakeSeconds?.record, 'function');
    assert.doesNotThrow(() => instruments.warmupCounters());
  });
});
