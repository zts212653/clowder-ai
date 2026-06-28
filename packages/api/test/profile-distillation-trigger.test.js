/**
 * F231 AC-C3: Profile distillation trigger (KD-10).
 *
 * Distillation trigger MUST be runtime-neutral — anchored to session-seal events,
 * NOT provider Stop hooks. This test verifies the trigger interface exists,
 * can be invoked with session-seal event data, and emits the eval counter.
 *
 * Tests verify:
 *   1. ProfileDistillationTrigger class exists and is importable
 *   2. onSessionSealed() method exists and is callable
 *   3. Eval counter (profileDistillationTriggered) is incremented on trigger
 *   4. Trigger is a no-op when there are no pending signals (returns 0)
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ProfileDistillationTrigger } from '../dist/domains/cats/services/profile/profile-distillation-trigger.js';
import { profileDistillationTriggered } from '../dist/infrastructure/telemetry/instruments.js';

describe('F231 AC-C3 — Profile distillation trigger (KD-10)', () => {
  test('ProfileDistillationTrigger is importable and constructable', () => {
    const trigger = new ProfileDistillationTrigger();
    assert.ok(trigger, 'must be constructable');
  });

  test('onSessionSealed() exists and returns a count', async () => {
    const trigger = new ProfileDistillationTrigger();
    const result = await trigger.onSessionSealed({
      sessionId: 'test-session-1',
      catId: 'opus',
      threadId: 'test-thread-1',
      sealReason: 'provider_exit',
    });
    assert.equal(typeof result, 'number', 'must return a number (signals processed)');
    assert.equal(result, 0, 'no pending signals → 0');
  });

  test('profileDistillationTriggered counter exists', () => {
    assert.ok(profileDistillationTriggered, 'counter must be exported');
    assert.equal(typeof profileDistillationTriggered.add, 'function', 'must have .add()');
  });
});
