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

  it('uses a distinct explicit id for a new active chain without inheriting the old task source', () => {
    for (const targetThreadId of ['thread-ancestor', 'thread-owner']) {
      for (const subjectRef of ['subject:task:old-work', 'pr:owner/repo#3515']) {
        const result = resolveCrossThreadCoordination({
          explicit: { phase: 'active', id: 'coord-new-work', subjectRef },
          incoming: boundIncoming,
          targetThreadId,
          mintId: () => 'must-not-mint',
        });

        assert.deepEqual(result.coordination, {
          id: 'coord-new-work',
          phase: 'active',
          hop: 0,
          subjectRef,
        });
        assert.equal(result.suppressRouting, false);
      }
    }
  });

  it('fails loud for every conflicting explicit terminal id before choosing a target or subject', () => {
    for (const incomingPhase of ['active', 'terminal', 'ack']) {
      for (const targetThreadId of ['thread-ancestor', 'thread-other']) {
        for (const explicitSubjectRef of ['subject:task:old-work', 'subject:task:new-work']) {
          const result = resolveCrossThreadCoordination({
            explicit: {
              phase: 'terminal',
              id: 'coord-explicit-other',
              subjectRef: explicitSubjectRef,
            },
            incoming: {
              ...boundIncoming,
              coordination: { ...boundIncoming.coordination, phase: incomingPhase },
            },
            targetThreadId,
            mintId: () => 'must-not-mint',
          });

          assert.deepEqual(result, {
            suppressRouting: true,
            conflict: {
              kind: 'coordination_id_conflict',
              message: 'Explicit terminal coordination id conflicts with the incoming coordination lineage.',
              incomingCoordinationId: 'coord-task-ancestor',
              explicitCoordinationId: 'coord-explicit-other',
            },
          });
        }
      }
    }
  });

  it('keeps same-id and missing-id terminal transitions on their exact lineage', () => {
    const activeTerminal = resolveCrossThreadCoordination({
      explicit: { phase: 'terminal', id: 'coord-task-ancestor' },
      incoming: boundIncoming,
      targetThreadId: 'thread-ancestor',
      mintId: () => 'must-not-mint',
    });
    assert.deepEqual(activeTerminal.coordination, {
      id: 'coord-task-ancestor',
      phase: 'terminal',
      hop: 5,
      subjectRef: 'subject:task:old-work',
    });
    assert.equal(activeTerminal.suppressRouting, false);

    const terminalAck = resolveCrossThreadCoordination({
      explicit: { phase: 'terminal' },
      incoming: {
        ...boundIncoming,
        coordination: { ...boundIncoming.coordination, phase: 'terminal' },
      },
      targetThreadId: 'thread-ancestor',
      mintId: () => 'must-not-mint',
    });
    assert.deepEqual(terminalAck.coordination, {
      id: 'coord-task-ancestor',
      phase: 'ack',
      hop: 5,
      subjectRef: 'subject:task:old-work',
    });
    assert.equal(terminalAck.suppressRouting, true);
  });

  it('fails loud when a same-id terminal claims a different bound subject', () => {
    const result = resolveCrossThreadCoordination({
      explicit: {
        phase: 'terminal',
        id: 'coord-task-ancestor',
        subjectRef: 'subject:task:new-work',
      },
      incoming: boundIncoming,
      targetThreadId: 'thread-ancestor',
      mintId: () => 'must-not-mint',
    });

    assert.deepEqual(result, {
      suppressRouting: true,
      conflict: {
        kind: 'coordination_subject_conflict',
        message: 'Explicit terminal coordination subject conflicts with the incoming coordination lineage.',
        coordinationId: 'coord-task-ancestor',
        incomingSubjectRef: 'subject:task:old-work',
        explicitSubjectRef: 'subject:task:new-work',
      },
    });
  });

  it('suppresses only a same-lineage terminal ACK returning to its source thread', () => {
    for (const explicitId of [undefined, 'coord-task-ancestor']) {
      for (const [targetThreadId, expectedPhase, expectedSuppression] of [
        ['thread-ancestor', 'ack', true],
        ['thread-other', 'terminal', false],
      ]) {
        const result = resolveCrossThreadCoordination({
          explicit: {
            phase: 'terminal',
            ...(explicitId ? { id: explicitId } : {}),
            subjectRef: 'subject:task:old-work',
          },
          incoming: {
            ...boundIncoming,
            coordination: { ...boundIncoming.coordination, phase: 'terminal' },
          },
          targetThreadId,
          mintId: () => 'must-not-mint',
        });

        assert.deepEqual(result.coordination, {
          id: 'coord-task-ancestor',
          phase: expectedPhase,
          hop: 5,
          subjectRef: 'subject:task:old-work',
        });
        assert.equal(result.suppressRouting, expectedSuppression);
      }
    }
  });

  it('never inherits a persisted ACK as implicit work', () => {
    for (const targetThreadId of ['thread-ancestor', 'thread-other']) {
      const result = resolveCrossThreadCoordination({
        incoming: {
          ...boundIncoming,
          coordination: { ...boundIncoming.coordination, phase: 'ack' },
        },
        targetThreadId,
        mintId: () => 'must-not-mint',
      });
      assert.deepEqual(result, { suppressRouting: false });
    }
  });

  it('forks explicit active work after a terminal even when the caller omits a new id', () => {
    const result = resolveCrossThreadCoordination({
      explicit: { phase: 'active', subjectRef: 'subject:task:new-work' },
      incoming: {
        ...boundIncoming,
        coordination: { ...boundIncoming.coordination, phase: 'terminal' },
      },
      targetThreadId: 'thread-ancestor',
      mintId: () => 'coord-new-after-terminal',
    });

    assert.deepEqual(result.coordination, {
      id: 'coord-new-after-terminal',
      phase: 'active',
      hop: 0,
      subjectRef: 'subject:task:new-work',
    });
    assert.equal(result.suppressRouting, false);
    assert.equal(result.contentDedupCoordinationKey, 'minted-active-root');
  });

  it('allows an explicit or minted standalone terminal only when no incoming id exists', () => {
    const explicitTerminal = resolveCrossThreadCoordination({
      explicit: { phase: 'terminal', id: 'coord-explicit', subjectRef: 'subject:task:done' },
      targetThreadId: 'thread-target',
      mintId: () => 'must-not-mint',
    });
    assert.deepEqual(explicitTerminal.coordination, {
      id: 'coord-explicit',
      phase: 'terminal',
      hop: 0,
      subjectRef: 'subject:task:done',
    });
    assert.equal(explicitTerminal.contentDedupCoordinationKey, undefined);

    const mintedTerminal = resolveCrossThreadCoordination({
      explicit: { phase: 'terminal' },
      targetThreadId: 'thread-target',
      mintId: () => 'coord-minted-terminal',
    });
    assert.deepEqual(mintedTerminal.coordination, {
      id: 'coord-minted-terminal',
      phase: 'terminal',
      hop: 0,
    });
    assert.equal(mintedTerminal.contentDedupCoordinationKey, 'minted-terminal-root');
  });
});
