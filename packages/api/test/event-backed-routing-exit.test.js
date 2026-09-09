import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  isEventBackedRoutingBypassProofValid,
  resolveEventBackedRoutingExit,
} from '../dist/domains/cats/services/agents/routing/guards/event-backed-routing-exit.js';

const THREAD_ID = 'thread-event-wait';
const CAT_ID = 'codex-sol';
const INVOCATION_ID = 'inv-event-wait';
const SUBJECT_KEY = 'pr:zts212653/cat-cafe#2856';

function activeWait(overrides = {}) {
  return {
    v: 1,
    generation: 4,
    subjectRef: SUBJECT_KEY,
    ownerFence: { kind: 'containing_task', generation: 4 },
    // The most favourable state this guard can be handed: a live tracker, owned by this cat, in
    // this thread, on this subject, subscribed to bot interaction, with a round actually open.
    baseline: {
      capturedAt: 1,
      headSha: 'head-a',
      botTurns: {
        'chatgpt-codex-connector[bot]': { triggerId: 4_936_000_000, openedAt: 1, headSha: 'head-a' },
      },
    },
    continuation: {
      when: [{ kind: 'pr_bot_interaction' }],
      // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract field.
      then: 'Consume the exact review result.',
    },
    expiresAt: Date.now() + 60_000,
    createdAt: 1,
    provenance: 'explicit_registration',
    ...overrides,
  };
}

function trackingTask(overrides = {}) {
  return {
    id: 'task-pr-2856',
    kind: 'pr_tracking',
    threadId: THREAD_ID,
    subjectKey: SUBJECT_KEY,
    title: 'PR tracking: zts212653/cat-cafe#2856',
    ownerCatId: CAT_ID,
    status: 'doing',
    why: 'waiting for review feedback',
    createdBy: CAT_ID,
    createdAt: 1,
    updatedAt: 2,
    automationState: { await: activeWait() },
    ...overrides,
  };
}

function taskStore(tasks) {
  return {
    async listByThread(threadId) {
      return tasks.filter((task) => task.threadId === threadId);
    },
  };
}

function resolve(tasks, overrides = {}) {
  return resolveEventBackedRoutingExit({
    taskStore: taskStore(tasks),
    threadId: THREAD_ID,
    catId: CAT_ID,
    invocationId: INVOCATION_ID,
    ...overrides,
  });
}

describe('F177/F280 event-backed routing exit resolver', () => {
  /*
   * F280 section 4b: F177 does not take its exit credential out of tracking. A round belongs to
   * the tracking OWNER, not to an invocation, so an open round says nothing about whether THIS
   * invocation is the one an event is coming back to — and stamping the registering invocation
   * onto it only recorded which turn probed HISTORY. The retired `pr_review_result_available`
   * predicate WAS an invocation's own act; nothing has replaced it, so the exit stays closed.
   *
   * This is the fail-closed direction on purpose: the cost is one held ball.
   */
  test('the most favourable tracking state still grants no bypass', async () => {
    assert.deepEqual(await resolve([trackingTask()]), { kind: 'reject', reason: 'predicate_missing' });
  });

  /*
   * sol R25's executable counterexample, kept as the regression: ONE hand-built proof, two
   * different invocation ids. The previous version of this file asserted `true` here and called
   * it "the invariant staying armed" — but the proof carries no invocation field, so those two
   * answers could never differ. Asserting `true` did not arm anything; it pre-approved the exact
   * hole `grantInvocationId` was deleted for.
   *
   * The validator is sealed until F177 owns a server-issued, invocation-bound credential, so the
   * only correct answer for a hand-made bypass is false — including for the shape that used to
   * pass every field check.
   */
  test('a hand-made bypass is invalid for every invocation, including a fully well-formed one', async () => {
    const wellFormed = {
      kind: 'bypass',
      taskId: 'task-pr-2856',
      subjectKey: SUBJECT_KEY,
      expectedSignal: 'review_posted',
      proof: {
        task: {
          kind: 'pr_tracking',
          status: 'doing',
          ownerCatId: CAT_ID,
          threadId: THREAD_ID,
          subjectKey: SUBJECT_KEY,
          generation: 4,
        },
        predicate: { kind: 'pr_bot_interaction', triggerCommentId: 4_936_000_000 },
      },
    };
    const identity = (invocationId) => ({ threadId: THREAD_ID, catId: CAT_ID, invocationId });
    // The two rows sol printed. They were `true / true`; the defect was never that they
    // disagreed, it was that they could not.
    assert.equal(isEventBackedRoutingBypassProofValid(wellFormed, identity(INVOCATION_ID)), false);
    assert.equal(isEventBackedRoutingBypassProofValid(wellFormed, identity('unrelated-later-inv')), false);
    // Nothing about the request can open it: not a missing invocation, not a rejection.
    assert.equal(isEventBackedRoutingBypassProofValid(wellFormed, identity(undefined)), false);
    assert.equal(
      isEventBackedRoutingBypassProofValid({ kind: 'reject', reason: 'predicate_missing' }, identity(INVOCATION_ID)),
      false,
    );
  });

  test('a wait not even subscribed to bot interaction reports the same closed reason', async () => {
    const task = trackingTask({
      automationState: {
        await: activeWait({
          continuation: {
            when: [{ kind: 'pr_head_changed' }],
            // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract field.
            then: 'Inspect the new HEAD.',
          },
        }),
      },
    });
    assert.deepEqual(await resolve([task]), { kind: 'reject', reason: 'predicate_missing' });
  });

  test('a stale owner generation does not bypass', async () => {
    const task = trackingTask({
      automationState: { await: activeWait({ ownerFence: { kind: 'containing_task', generation: 3 } }) },
    });
    assert.deepEqual(await resolve([task]), { kind: 'reject', reason: 'generation_mismatch' });
  });

  test('done, foreign-owner, and mismatched-subject waits fail closed', async () => {
    assert.deepEqual(await resolve([trackingTask({ status: 'done' })]), {
      kind: 'reject',
      reason: 'task_done',
    });
    assert.deepEqual(await resolve([trackingTask({ ownerCatId: 'opus47' })]), {
      kind: 'reject',
      reason: 'owner_mismatch',
    });
    const wrongSubject = trackingTask({
      automationState: { await: activeWait({ subjectRef: 'pr:zts212653/cat-cafe#9999' }) },
    });
    assert.deepEqual(await resolve([wrongSubject]), { kind: 'reject', reason: 'subject_mismatch' });
  });

  test('empty task list has no event-backed routing candidate', async () => {
    assert.deepEqual(await resolve([]), { kind: 'reject', reason: 'no_candidate' });
  });

  test('missing invocation identity fails closed', async () => {
    assert.deepEqual(await resolve([trackingTask()], { invocationId: undefined }), {
      kind: 'reject',
      reason: 'missing_invocation',
    });
  });

  test('missing TaskStore fails closed', async () => {
    assert.deepEqual(
      await resolveEventBackedRoutingExit({
        taskStore: undefined,
        threadId: THREAD_ID,
        catId: CAT_ID,
        invocationId: INVOCATION_ID,
      }),
      { kind: 'reject', reason: 'state_source_unavailable' },
    );
  });

  test('TaskStore query failure fails closed without throwing', async () => {
    assert.deepEqual(
      await resolveEventBackedRoutingExit({
        taskStore: {
          async listByThread() {
            throw new Error('redis unavailable');
          },
        },
        threadId: THREAD_ID,
        catId: CAT_ID,
        invocationId: INVOCATION_ID,
      }),
      { kind: 'reject', reason: 'query_failed' },
    );
  });
});
