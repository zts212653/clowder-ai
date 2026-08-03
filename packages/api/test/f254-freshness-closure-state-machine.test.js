import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  advanceFreshnessClosure,
  blockFreshnessClosureAttempt,
  claimFreshnessClosureAttempt,
  commitFreshnessClosureAttempt,
  createFreshnessClosure,
  disposeFreshnessClosure,
  blockFreshnessClosurePreflight,
  refreshFreshnessClosureFrontier,
  supersedeFreshnessClosureAttempt,
} = await import('../dist/domains/cats/services/freshness/FreshnessClosureStateMachine.js');
const { blockFreshnessClosureRecovery, recoverFreshnessClosureAttempt, retryFreshnessClosure } = await import(
  '../dist/domains/cats/services/freshness/FreshnessClosureRecoveryState.js'
);

const scope = { userId: 'user-1', threadId: 'thread-1', catId: 'codex-sol' };

function openClosure() {
  return createFreshnessClosure({
    id: 'closure-1',
    ...scope,
    invocationId: 'inv-base',
    draftContent: 'old answer',
    requiredMessageIds: ['msg-2'],
    requiredFrontierMessageId: 'msg-2',
    observedRawFrontierMessageId: 'msg-2',
    now: 100,
  });
}

describe('F254 Phase E — freshness closure state machine', () => {
  it('opens one pending responsibility with bounded full-draft retention', () => {
    const closure = openClosure();
    assert.equal(closure.status, 'pending');
    assert.deepEqual(closure.requiredMessageIds, ['msg-2']);
    assert.equal(closure.baseDraft.content, 'old answer');
    assert.equal(closure.latestDraft.content, 'old answer');
    assert.equal(closure.automaticSuccessorAttemptCount, 0);
    assert.equal(closure.retryEpoch, 0);
    assert.equal(closure.revision, 0);
  });

  it('opens replay-unsafe stale output directly as blocked and retains the fence across explicit retry', () => {
    const blocked = createFreshnessClosure({
      id: 'closure-side-effect',
      ...scope,
      invocationId: 'inv-side-effect',
      draftContent: 'stale answer after hold',
      requiredMessageIds: ['msg-2'],
      requiredFrontierMessageId: 'msg-2',
      observedRawFrontierMessageId: 'msg-2',
      replayUnsafeToolNames: ['mcp__cat-cafe__cat_cafe_hold_ball', 'Edit', 'Edit'],
      now: 100,
    });

    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockedReason, 'side_effect_requires_explicit_retry');
    assert.deepEqual(blocked.replayUnsafeToolNames, ['Edit', 'mcp__cat-cafe__cat_cafe_hold_ball']);

    const retried = retryFreshnessClosure(blocked, {
      actorId: 'user-1',
      evidenceRef: 'retry-click',
      now: 200,
    });
    assert.equal(retried.status, 'pending');
    assert.deepEqual(retried.replayUnsafeToolNames, blocked.replayUnsafeToolNames);
  });

  it('advances the required frontier monotonically and dedupes identities', () => {
    const advanced = advanceFreshnessClosure(openClosure(), {
      ...scope,
      invocationId: 'inv-newer-draft',
      draftContent: 'newer draft',
      requiredMessageIds: ['msg-2', 'msg-3'],
      requiredFrontierMessageId: 'msg-3',
      observedRawFrontierMessageId: 'msg-3',
      now: 200,
    });
    assert.deepEqual(advanced.requiredMessageIds, ['msg-2', 'msg-3']);
    assert.equal(advanced.requiredFrontierMessageId, 'msg-3');
    assert.equal(advanced.baseDraft.content, 'old answer');
    assert.equal(advanced.latestDraft.content, 'newer draft');
    assert.throws(
      () =>
        advanceFreshnessClosure(advanced, {
          ...scope,
          invocationId: 'inv-regress',
          draftContent: 'bad',
          requiredMessageIds: ['msg-1'],
          requiredFrontierMessageId: 'msg-1',
          observedRawFrontierMessageId: 'msg-1',
          now: 300,
        }),
      /regress/,
    );
  });

  it('IR-10: preserves the immutable origin trigger across frontier advances', () => {
    const opened = createFreshnessClosure({
      id: 'closure-origin',
      ...scope,
      invocationId: 'inv-base',
      originTriggerMessageId: 'msg-origin',
      draftContent: 'old answer',
      requiredMessageIds: ['msg-2'],
      requiredFrontierMessageId: 'msg-2',
      observedRawFrontierMessageId: 'msg-2',
      now: 100,
    });
    const advanced = advanceFreshnessClosure(opened, {
      ...scope,
      invocationId: 'inv-newer',
      originTriggerMessageId: 'msg-wrong-new-origin',
      draftContent: 'new answer',
      requiredMessageIds: ['msg-3'],
      requiredFrontierMessageId: 'msg-3',
      observedRawFrontierMessageId: 'msg-3',
      now: 200,
    });

    assert.equal(opened.originTriggerMessageId, 'msg-origin');
    assert.equal(advanced.originTriggerMessageId, 'msg-origin');
  });

  it('IR-10: CAS refresh merges competing frontier evidence without regressing custody', () => {
    const current = advanceFreshnessClosure(openClosure(), {
      ...scope,
      invocationId: 'inv-current',
      draftContent: 'current retained draft',
      requiredMessageIds: ['msg-3'],
      requiredFrontierMessageId: 'msg-3',
      observedRawFrontierMessageId: 'msg-4',
      now: 200,
    });
    const refreshed = refreshFreshnessClosureFrontier(current, {
      requiredMessageIds: ['msg-2', 'msg-5'],
      requiredFrontierMessageId: 'msg-5',
      observedRawFrontierMessageId: 'msg-3',
      now: 300,
    });

    assert.deepEqual(refreshed.requiredMessageIds, ['msg-2', 'msg-3', 'msg-5']);
    assert.equal(refreshed.requiredFrontierMessageId, 'msg-5');
    assert.equal(refreshed.observedRawFrontierMessageId, 'msg-4');
    assert.equal(refreshed.latestDraft.content, 'current retained draft');
  });

  it('IR-10: incomplete preflight blocks pending custody without fabricating an attempt', () => {
    const blocked = blockFreshnessClosurePreflight(openClosure(), {
      evidenceRefs: ['raw-frontier:incomplete:msg-2:msg-3'],
      now: 200,
    });

    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockedReason, 'freshness_preflight_incomplete');
    assert.deepEqual(blocked.blockedEvidenceRefs, ['raw-frontier:incomplete:msg-2:msg-3']);
    assert.deepEqual(blocked.attempts, []);
    assert.equal(blocked.latestDraft.content, 'old answer');
  });

  it('allows only the claimed invocation to finish an attempt', () => {
    const running = claimFreshnessClosureAttempt(openClosure(), {
      invocationId: 'inv-successor',
      inputFrontierMessageId: 'msg-2',
      observedRawFrontierMessageId: 'msg-2',
      now: 200,
    });
    assert.equal(running.status, 'running');
    assert.equal(running.automaticSuccessorAttemptCount, 1);
    assert.throws(
      () =>
        commitFreshnessClosureAttempt(running, {
          invocationId: 'inv-wrong',
          messageId: 'final-1',
          observedRawFrontierMessageId: 'msg-2',
          now: 300,
        }),
      /claimed invocation/,
    );
  });

  it('returns a stale running attempt to pending without retaining another full body', () => {
    const running = claimFreshnessClosureAttempt(openClosure(), {
      invocationId: 'inv-successor',
      inputFrontierMessageId: 'msg-2',
      observedRawFrontierMessageId: 'msg-2',
      now: 200,
    });
    const pending = supersedeFreshnessClosureAttempt(running, {
      invocationId: 'inv-successor',
      draftContent: 'replacement that also became stale',
      requiredMessageIds: ['msg-3'],
      requiredFrontierMessageId: 'msg-3',
      observedRawFrontierMessageId: 'msg-3',
      evidenceRefs: ['event-1'],
      now: 300,
    });
    assert.equal(pending.status, 'pending');
    assert.equal(pending.activeAttempt, undefined);
    assert.equal(pending.latestDraft.content, 'replacement that also became stale');
    assert.equal(pending.attempts.length, 1);
    assert.equal(pending.attempts[0].draftLength, 'replacement that also became stale'.length);
    assert.equal('draftContent' in pending.attempts[0], false);
  });

  it('blocks the sixth automatic claim and explicit retry opens a new budget epoch', () => {
    let closure = openClosure();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const invocationId = `inv-${attempt}`;
      closure = claimFreshnessClosureAttempt(closure, {
        invocationId,
        inputFrontierMessageId: closure.requiredFrontierMessageId,
        observedRawFrontierMessageId: closure.requiredFrontierMessageId,
        now: 200 + attempt * 10,
      });
      closure = supersedeFreshnessClosureAttempt(closure, {
        invocationId,
        draftContent: `draft-${attempt}`,
        requiredMessageIds: [`msg-${attempt + 2}`],
        requiredFrontierMessageId: `msg-${attempt + 2}`,
        observedRawFrontierMessageId: `msg-${attempt + 2}`,
        evidenceRefs: [],
        now: 205 + attempt * 10,
      });
    }

    closure = claimFreshnessClosureAttempt(closure, {
      invocationId: 'inv-6',
      inputFrontierMessageId: closure.requiredFrontierMessageId,
      observedRawFrontierMessageId: closure.requiredFrontierMessageId,
      now: 400,
    });
    assert.equal(closure.status, 'blocked');
    assert.equal(closure.blockedReason, 'attempt_budget_exhausted');

    const retried = retryFreshnessClosure(closure, {
      actorId: 'user-1',
      evidenceRef: 'retry-click-1',
      now: 500,
    });
    assert.equal(retried.status, 'pending');
    assert.equal(retried.retryEpoch, 1);
    assert.equal(retried.automaticSuccessorAttemptCount, 0);
  });

  it('commits once, or blocks/disposes with explicit evidence', () => {
    const running = claimFreshnessClosureAttempt(openClosure(), {
      invocationId: 'inv-successor',
      inputFrontierMessageId: 'msg-2',
      observedRawFrontierMessageId: 'msg-2',
      now: 200,
    });
    const committed = commitFreshnessClosureAttempt(running, {
      invocationId: 'inv-successor',
      messageId: 'final-1',
      observedRawFrontierMessageId: 'msg-2',
      now: 300,
    });
    assert.equal(committed.status, 'committed');
    assert.equal(committed.committedMessageId, 'final-1');
    assert.throws(
      () =>
        advanceFreshnessClosure(committed, {
          ...scope,
          invocationId: 'inv-late',
          draftContent: 'late',
          requiredMessageIds: ['msg-3'],
          requiredFrontierMessageId: 'msg-3',
          observedRawFrontierMessageId: 'msg-3',
          now: 400,
        }),
      /terminal/,
    );

    const blocked = blockFreshnessClosureAttempt(running, {
      invocationId: 'inv-successor',
      reason: 'user_cancel',
      evidenceRefs: ['cancel-1'],
      now: 300,
    });
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockedReason, 'user_cancel');

    const disposed = disposeFreshnessClosure(blocked, {
      kind: 'dismissed',
      actorId: 'user-1',
      evidenceRef: 'dismiss-1',
      now: 400,
    });
    assert.equal(disposed.status, 'disposed');
  });

  it('recovers an orphan running attempt to pending without losing responsibility', () => {
    const running = claimFreshnessClosureAttempt(openClosure(), {
      invocationId: 'inv-crashed',
      inputFrontierMessageId: 'msg-2',
      observedRawFrontierMessageId: 'msg-2',
      now: 200,
    });
    const recovered = recoverFreshnessClosureAttempt(running, {
      evidenceRef: 'startup-reconciler',
      now: 300,
    });
    assert.equal(recovered.status, 'pending');
    assert.equal(recovered.activeAttempt, undefined);
    assert.equal(recovered.attempts.at(-1).outcome, 'failed');
    assert.deepEqual(recovered.requiredMessageIds, ['msg-2']);
  });

  it('blocks startup recovery before model execution with durable evidence', () => {
    const blocked = blockFreshnessClosureRecovery(openClosure(), {
      evidenceRefs: ['startup:pending_requires_explicit_retry'],
      now: 3_600_000,
    });

    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockedReason, 'startup_recovery_requires_explicit_retry');
    assert.deepEqual(blocked.blockedEvidenceRefs, ['startup:pending_requires_explicit_retry']);
    assert.equal(blocked.activeAttempt, undefined);
    assert.deepEqual(blocked.attempts, [], 'startup must not fabricate a model invocation attempt');

    const retried = retryFreshnessClosure(blocked, {
      actorId: 'user-1',
      evidenceRef: 'api:retry',
      now: 3_600_100,
    });
    assert.equal(retried.status, 'pending');
    assert.equal(retried.blockedEvidenceRefs, undefined);
  });

  it('blocks a crashed running attempt and records the real invocation evidence', () => {
    const running = claimFreshnessClosureAttempt(openClosure(), {
      invocationId: 'inv-crashed',
      inputFrontierMessageId: 'msg-2',
      observedRawFrontierMessageId: 'msg-2',
      now: 200,
    });
    const blocked = blockFreshnessClosureRecovery(running, {
      evidenceRefs: ['startup:running_attempt_expired', 'age-ms:7200000'],
      now: 7_200_200,
    });

    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.attempts.at(-1).invocationId, 'inv-crashed');
    assert.equal(blocked.attempts.at(-1).outcome, 'failed');
    assert.deepEqual(blocked.blockedEvidenceRefs, ['startup:running_attempt_expired', 'age-ms:7200000']);
  });
});
