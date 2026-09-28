import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';

const MODULE_URL = new URL('../dist/domains/ball-custody/wait-state-machine.js', import.meta.url);

function activeAwait(overrides = {}) {
  return {
    v: 1,
    generation: 4,
    subjectRef: 'pr:zts212653/cat-cafe#3300',
    ownerFence: { kind: 'containing_task', generation: 4 },
    baseline: {
      capturedAt: 100,
      headSha: 'aaaa1111',
      review: {
        inlineCommentCursor: 10,
        conversationCommentCursor: 20,
        decisionCursor: 30,
      },
    },
    continuation: {
      when: [{ kind: 'pr_head_changed' }, { kind: 'pr_ci_terminal' }],
      // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract names this continuation field `then`.
      then: 'Re-lock the exact HEAD.',
    },
    expiresAt: 10_000,
    createdAt: 100,
    ...overrides,
  };
}

describe('F280 wait state machine', () => {
  it('the pure lifecycle module exists', () => {
    assert.equal(
      existsSync(MODULE_URL),
      true,
      'wait-state-machine must be implemented before this test can turn green',
    );
  });

  it('consumes one generation once and rejects stale scheduler replay', async () => {
    const { transitionWaitState } = await import(MODULE_URL.href);
    const current = { await: activeAwait() };

    const matched = transitionWaitState(current, {
      type: 'predicates_matched',
      generation: 4,
      at: 500,
      matched: [{ kind: 'pr_head_changed', delta: 'HEAD aaaa111 → bbbb222' }],
    });
    assert.equal(matched.applied, true);
    assert.equal(matched.state.await, undefined);
    assert.equal(matched.state.waitOutcome?.reason, 'matched');
    assert.equal(matched.state.waitOutcome?.generation, 4);
    assert.deepEqual(matched.state.waitOutcome?.ownerFence, {
      kind: 'containing_task',
      generation: 4,
    });

    const replay = transitionWaitState(matched.state, {
      type: 'predicates_matched',
      generation: 4,
      at: 501,
      matched: [{ kind: 'pr_head_changed', delta: 'HEAD aaaa111 → bbbb222' }],
    });
    assert.deepEqual(replay, { applied: false, reason: 'generation_inactive', state: matched.state });
  });

  /*
   * #1392 AC-2 reverses what this test used to assert. It pinned `delivery: 'not_applicable'` —
   * a deadline that ends tracking and tells nobody. That is the first failure #1392 opened with
   * ("tracking expired before the maintainer reviewed — silent disconnect"). Expiry still wins
   * over a late match, but it is now a loud terminal outcome — and, like a merge, it ends tracking,
   * not the poll it was noticed in: that match may have happened before the deadline.
   */
  it('expiry wins over a late predicate result and is delivered as a loud terminal outcome', async () => {
    const { transitionWaitState } = await import(MODULE_URL.href);
    const current = { await: activeAwait({ expiresAt: 500 }) };

    const result = transitionWaitState(current, {
      type: 'predicates_matched',
      generation: 4,
      at: 500,
      matched: [{ kind: 'pr_ci_terminal', delta: 'CI pending → pass' }],
      renewal: { kind: 'renew', baseline: activeAwait().baseline },
    });

    assert.equal(result.applied, true);
    assert.equal(result.state.waitOutcome?.reason, 'expired');
    assert.equal(result.state.waitOutcome?.delivery, 'pending', 'an expiry nobody hears about is the #1392 failure');
    assert.equal(result.state.await, undefined, 'and an expired wait is never renewed');
    assert.deepEqual(
      result.state.waitOutcome?.matched,
      [{ kind: 'pr_ci_terminal', delta: 'CI pending → pass' }],
      'what that poll matched is delivered with the expiry, not dropped',
    );
  });

  /*
   * #1392 D4 (accepted in #1474): a settled terminal fact outranks the clock.
   *
   * This case previously asserted the opposite — that a merge noticed at the deadline is reported as
   * `expired` with the subject state demoted to metadata. The typed `reason` is what the next holder
   * routes on: `expired` says "re-arm?", a merge says "wrap up", and no metadata field repairs a
   * wrong verb. The matches observed in that same poll are still carried.
   */
  it('a subject terminal noticed at the deadline reports the terminal fact and keeps that poll’s matches', async () => {
    const { transitionWaitState } = await import(MODULE_URL.href);
    const matched = [{ kind: 'pr_conversation_comment_added', delta: 'conversation comment #31 by maintainer' }];

    const result = transitionWaitState(
      { await: activeAwait({ expiresAt: 500 }) },
      { type: 'subject_terminal', generation: 4, at: 500, subjectState: 'merged', matched },
    );

    assert.equal(result.state.waitOutcome?.reason, 'subject_terminal');
    assert.deepEqual(result.state.waitOutcome?.matched, matched);
    assert.equal(result.state.waitOutcome?.terminalSubjectState, 'merged');
  });

  for (const subjectState of ['closed', 'merged']) {
    for (const [label, at] of [
      ['at the deadline itself', 500],
      ['long after the deadline', 9_000_000],
    ]) {
      it(`a subject that reached ${subjectState} ${label} is not reported as a timeout`, async () => {
        const { transitionWaitState } = await import(MODULE_URL.href);

        const result = transitionWaitState(
          { await: activeAwait({ expiresAt: 500 }) },
          { type: 'subject_terminal', generation: 4, at, subjectState },
        );

        assert.equal(result.applied, true);
        assert.equal(result.state.waitOutcome?.reason, 'subject_terminal');
        assert.equal(result.state.waitOutcome?.terminalSubjectState, subjectState);
      });
    }
  }

  for (const [label, at] of [
    ['at the deadline itself', 500],
    ['long after the deadline', 9_000_000],
  ]) {
    it(`an explicit cancel ${label} keeps both its reason and the cat who cancelled`, async () => {
      const { transitionWaitState } = await import(MODULE_URL.href);
      const actor = { kind: 'cat', catId: 'opus' };

      const result = transitionWaitState(
        { await: activeAwait({ expiresAt: 500 }) },
        { type: 'user_cancel', generation: 4, at, actor },
      );

      assert.equal(result.state.waitOutcome?.reason, 'user_cancel');
      assert.deepEqual(
        result.state.waitOutcome?.actor,
        actor,
        'the expiry branch built its outcome without an actor, so a late cancel was attributed to the system',
      );
    });
  }

  it('a generation that already terminalized is never rewritten by a later close', async () => {
    const { transitionWaitState } = await import(MODULE_URL.href);

    const result = transitionWaitState(
      { await: undefined, waitOutcome: { v: 1, reason: 'expired', generation: 4 } },
      { type: 'subject_terminal', generation: 4, at: 9_000_000, subjectState: 'closed' },
    );

    assert.equal(result.applied, false);
    assert.equal(result.reason, 'generation_inactive');
  });

  /*
   * #1392 AC-2: `expiresAt` is optional, and omitted means no time-based termination at all.
   * An absent deadline must not be read as "already expired" (NaN/undefined comparisons are
   * false in one direction and silently true in another), and it must not be read as "never
   * matched" either — both would change the lifecycle without anyone asking for a deadline.
   */
  it('an await with no expiresAt is never expired by time, however late', async () => {
    const { transitionWaitState } = await import(MODULE_URL.href);
    const { expiresAt: _omitted, ...noDeadline } = activeAwait();
    const result = transitionWaitState(
      { await: noDeadline },
      {
        type: 'predicates_matched',
        generation: 4,
        at: Number.MAX_SAFE_INTEGER,
        matched: [{ kind: 'pr_ci_terminal', delta: 'CI pending → pass' }],
      },
    );

    assert.equal(result.applied, true);
    assert.equal(result.state.waitOutcome?.reason, 'matched', 'an omitted deadline is not an expired one');
  });

  it('an await with no expiresAt and nothing matched stays active', async () => {
    const { transitionWaitState } = await import(MODULE_URL.href);
    const { expiresAt: _omitted, ...noDeadline } = activeAwait();
    const result = transitionWaitState(
      { await: noDeadline },
      { type: 'predicates_matched', generation: 4, at: Number.MAX_SAFE_INTEGER, matched: [] },
    );

    assert.equal(result.applied, false);
    assert.equal(result.reason, 'empty_match');
  });

  it('isAwaitExpired answers the deadline question the same way for every caller', async () => {
    const { isAwaitExpired } = await import(MODULE_URL.href);
    const { expiresAt: _omitted, ...noDeadline } = activeAwait();

    assert.equal(isAwaitExpired(noDeadline, Number.MAX_SAFE_INTEGER), false, 'no deadline never expires');
    assert.equal(isAwaitExpired(activeAwait({ expiresAt: 500 }), 499), false);
    assert.equal(isAwaitExpired(activeAwait({ expiresAt: 500 }), 500), true, 'the deadline itself is expired');
  });

  /*
   * #1392 AC-1: one registration, many one-shot generations. Consuming N and installing N+1 is a
   * single transition, so there is no state in which N is consumed and nothing is armed.
   */
  it('renewal consumes N and installs N+1 in one transition, carrying when, then and the deadline', async () => {
    const { transitionWaitState } = await import(MODULE_URL.href);
    const active = activeAwait();
    const nextBaseline = { ...active.baseline, capturedAt: 700, headSha: 'bbbb2222' };

    const result = transitionWaitState(
      { await: active },
      {
        type: 'predicates_matched',
        generation: 4,
        at: 700,
        matched: [{ kind: 'pr_head_changed', delta: 'HEAD aaaa111 → bbbb222' }],
        renewal: { kind: 'renew', baseline: nextBaseline },
      },
    );

    assert.equal(result.applied, true);
    const { waitOutcome, await: next } = result.state;
    assert.equal(waitOutcome.generation, 4, 'the outcome belongs to the generation that matched');
    assert.equal(waitOutcome.reason, 'matched');
    assert.equal(waitOutcome.delivery, 'pending');
    assert.equal(waitOutcome.renewal, 'rearmed');

    assert.equal(next.generation, 5);
    assert.deepEqual(next.ownerFence, { kind: 'containing_task', generation: 5 });
    assert.deepEqual(next.continuation, active.continuation, 'renewal reuses the same exact when[] and then');
    assert.deepEqual(next.baseline, nextBaseline);
    assert.equal(next.createdAt, 700);
    assert.equal(next.expiresAt, active.expiresAt, 'renewal never extends an explicit deadline');
  });

  /*
   * The review-loop brake rewrites `then` for ONE delivery ("pause once"). The lifecycle applies
   * that override to the await it hands the transition, so if renewal copied that await, every
   * later generation would carry the pause forever. N+1 takes the continuation the renewal
   * instruction names — the registered one.
   */
  it('a one-delivery override of then does not leak into the next generation', async () => {
    const { transitionWaitState } = await import(MODULE_URL.href);
    const registered = activeAwait();
    const overridden = {
      ...registered,
      // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract names this continuation field `then`.
      continuation: { ...registered.continuation, then: '[review-loop-brake]' },
    };

    const result = transitionWaitState(
      { await: overridden },
      {
        type: 'predicates_matched',
        generation: 4,
        at: 700,
        matched: [{ kind: 'pr_head_changed', delta: 'HEAD aaaa111 → bbbb222' }],
        renewal: { kind: 'renew', baseline: registered.baseline, continuation: registered.continuation },
      },
    );

    assert.equal(result.state.waitOutcome.nextStep, '[review-loop-brake]', 'this delivery is paused once');
    assert.deepEqual(result.state.await.continuation, registered.continuation, 'the next generation is not');
  });

  it('autoRenew false keeps the explicit single-fire behaviour', async () => {
    const { transitionWaitState } = await import(MODULE_URL.href);
    const result = transitionWaitState(
      { await: activeAwait({ autoRenew: false }) },
      {
        type: 'predicates_matched',
        generation: 4,
        at: 700,
        matched: [{ kind: 'pr_head_changed', delta: 'HEAD aaaa111 → bbbb222' }],
        renewal: { kind: 'renew', baseline: activeAwait().baseline },
      },
    );

    assert.equal(result.state.await, undefined);
    assert.equal(result.state.waitOutcome.renewal, undefined, 'a one-shot wait does not claim to have rearmed');
  });

  it('a renewal that cannot be installed is delivered loudly instead of claiming tracking continues', async () => {
    const { transitionWaitState } = await import(MODULE_URL.href);
    const result = transitionWaitState(
      { await: activeAwait() },
      {
        type: 'predicates_matched',
        generation: 4,
        at: 700,
        matched: [{ kind: 'pr_head_changed', delta: 'HEAD aaaa111 → bbbb222' }],
        renewal: { kind: 'rearm_failed' },
      },
    );

    assert.equal(result.state.await, undefined, 'nothing is armed, so nothing may say it is');
    assert.equal(result.state.waitOutcome.delivery, 'pending', 'the event itself still has to be delivered');
    assert.equal(result.state.waitOutcome.renewal, 'rearm_failed');
  });

  it('a subject reaching a terminal state is never renewed', async () => {
    const { transitionWaitState } = await import(MODULE_URL.href);
    const result = transitionWaitState(
      { await: activeAwait() },
      { type: 'subject_terminal', generation: 4, at: 700, subjectState: 'merged' },
    );

    assert.equal(result.state.await, undefined);
    assert.equal(result.state.waitOutcome.reason, 'subject_terminal');
  });

  it('owner change terminalizes the old generation silently', async () => {
    const { transitionWaitState } = await import(MODULE_URL.href);
    const result = transitionWaitState({ await: activeAwait() }, { type: 'owner_changed', generation: 4, at: 600 });

    assert.equal(result.applied, true);
    assert.equal(result.state.waitOutcome?.reason, 'owner_changed');
    assert.equal(result.state.waitOutcome?.delivery, 'not_applicable');
  });

  it('retains an action-successor owner fence without promoting it to action authority', async () => {
    const { transitionWaitState } = await import(MODULE_URL.href);
    const ownerFence = { kind: 'action_successor', leaseId: 'lease-review-7', generation: 9 };
    const result = transitionWaitState(
      { await: activeAwait({ generation: 9, ownerFence }) },
      {
        type: 'predicates_matched',
        generation: 9,
        at: 600,
        matched: [{ kind: 'pr_head_changed', delta: 'HEAD aaaa111 → bbbb222' }],
      },
    );

    assert.equal(result.applied, true);
    assert.deepEqual(result.state.waitOutcome?.ownerFence, ownerFence);
    assert.equal(Object.hasOwn(result.state.waitOutcome ?? {}, 'actionSuccessorFence'), false);
  });
});
