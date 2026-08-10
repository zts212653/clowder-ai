import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { resolveCrossThreadCoordination } = await import('../dist/routes/cross-thread-coordination.js');

describe('cross-thread review action affinity', () => {
  const boundIncoming = {
    sourceThreadId: 'thread-ancestor',
    coordination: {
      id: 'coord-task-ancestor',
      phase: 'active',
      hop: 4,
      subjectRef: 'subject:task:old-work',
    },
  };

  it('mints a new coordination generation when an explicit active action changes subject', () => {
    const result = resolveCrossThreadCoordination({
      explicit: {
        phase: 'active',
        id: 'coord-task-ancestor',
        subjectRef: 'pr:owner/repo#3515',
      },
      incoming: boundIncoming,
      targetThreadId: 'thread-owner',
      mintId: () => 'coord-review-3515',
    });

    assert.deepEqual(result.coordination, {
      id: 'coord-review-3515',
      phase: 'active',
      hop: 0,
      subjectRef: 'pr:owner/repo#3515',
    });
    assert.equal(result.contentDedupCoordinationKey, 'minted-active-root');
  });

  it('continues the existing generation when the explicit action keeps the same subject', () => {
    const result = resolveCrossThreadCoordination({
      explicit: { phase: 'active', subjectRef: 'subject:task:old-work' },
      incoming: boundIncoming,
      targetThreadId: 'thread-owner',
      mintId: () => 'must-not-mint',
    });

    assert.deepEqual(result.coordination, {
      id: 'coord-task-ancestor',
      phase: 'active',
      hop: 5,
      subjectRef: 'subject:task:old-work',
    });
  });

  it('does not inherit an incoming active chain for an implicit message that stays in the owner thread', () => {
    const result = resolveCrossThreadCoordination({
      incoming: boundIncoming,
      targetThreadId: 'thread-owner',
      mintId: () => 'must-not-mint',
    });

    assert.deepEqual(result, { suppressRouting: false });
  });

  it('inherits an incoming active chain for an implicit reply sent back to its source thread', () => {
    const result = resolveCrossThreadCoordination({
      incoming: boundIncoming,
      targetThreadId: 'thread-ancestor',
      mintId: () => 'must-not-mint',
    });

    assert.deepEqual(result.coordination, {
      id: 'coord-task-ancestor',
      phase: 'active',
      hop: 5,
      subjectRef: 'subject:task:old-work',
    });
    assert.equal(result.suppressRouting, false);
  });

  it('preserves explicit legacy inheritance for an unbound same-chain work hop', () => {
    const result = resolveCrossThreadCoordination({
      explicit: { phase: 'active' },
      incoming: {
        sourceThreadId: 'thread-ancestor',
        coordination: { id: 'coord-unbound', phase: 'active', hop: 2 },
      },
      targetThreadId: 'thread-owner',
      mintId: () => 'must-not-mint',
    });

    assert.deepEqual(result.coordination, {
      id: 'coord-unbound',
      phase: 'active',
      hop: 3,
    });
  });
});
