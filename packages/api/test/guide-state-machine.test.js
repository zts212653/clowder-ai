import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('GuideStateMachine', () => {
  test('validates forward-only transitions', async () => {
    const { isValidTransition, validTransitionsFrom, isTerminal } = await import(
      '../dist/domains/guides/GuideStateMachine.js'
    );

    assert.equal(isValidTransition('offered', 'awaiting_choice'), true);
    assert.equal(isValidTransition('awaiting_choice', 'active'), true);
    assert.equal(isValidTransition('active', 'completed'), true);
    assert.equal(isValidTransition('active', 'offered'), false);
    assert.deepEqual(validTransitionsFrom('offered'), ['awaiting_choice', 'active', 'cancelled']);
    assert.equal(isTerminal('completed'), true);
    assert.equal(isTerminal('cancelled'), true);
    assert.equal(isTerminal('active'), false);
  });

  test('creates and applies transitions with timestamps', async () => {
    const { createOfferedState, applyTransition } = await import('../dist/domains/guides/GuideStateMachine.js');

    const originalNow = Date.now;
    Date.now = () => 1234;
    const offered = createOfferedState({ guideId: 'add-member', userId: 'user-1', offeredBy: 'opus' });
    assert.deepEqual(offered, {
      v: 1,
      guideId: 'add-member',
      status: 'offered',
      userId: 'user-1',
      offeredAt: 1234,
      offeredBy: 'opus',
    });

    Date.now = () => 5678;
    const active = applyTransition(offered, 'active');
    assert.equal(active.status, 'active');
    assert.equal(active.startedAt, 5678);

    Date.now = () => 9999;
    const completed = applyTransition(active, 'completed', 3);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.currentStep, 3);
    assert.equal(completed.completedAt, 9999);

    Date.now = originalNow;
  });
});
