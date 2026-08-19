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

  it('expiry wins over a late predicate result and never requests a wake', async () => {
    const { transitionWaitState } = await import(MODULE_URL.href);
    const current = { await: activeAwait({ expiresAt: 500 }) };

    const result = transitionWaitState(current, {
      type: 'predicates_matched',
      generation: 4,
      at: 500,
      matched: [{ kind: 'pr_ci_terminal', delta: 'CI pending → pass' }],
    });

    assert.equal(result.applied, true);
    assert.equal(result.state.waitOutcome?.reason, 'expired');
    assert.equal(result.state.waitOutcome?.delivery, 'not_applicable');
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
