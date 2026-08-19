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
    baseline: { capturedAt: 1, headSha: 'head-a' },
    continuation: {
      when: [{ kind: 'pr_review_result_available', triggerCommentId: 4_936_000_000 }],
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
  test('an active correlated review-result wait grants a typed bypass', async () => {
    assert.deepEqual(await resolve([trackingTask()]), {
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
        predicate: {
          kind: 'pr_review_result_available',
          triggerCommentId: 4_936_000_000,
        },
      },
    });
  });

  test('consumer-side proof validation rejects forged task and predicate boundaries', async () => {
    const valid = await resolve([trackingTask()]);
    assert.equal(valid.kind, 'bypass');
    if (valid.kind !== 'bypass') return;
    const identity = { threadId: THREAD_ID, catId: CAT_ID, invocationId: INVOCATION_ID };
    const forgedProofs = [
      { ...valid.proof, task: { ...valid.proof.task, kind: 'work' } },
      { ...valid.proof, task: { ...valid.proof.task, status: 'done' } },
      { ...valid.proof, task: { ...valid.proof.task, ownerCatId: 'opus48' } },
      { ...valid.proof, task: { ...valid.proof.task, threadId: 'thread-other' } },
      { ...valid.proof, task: { ...valid.proof.task, subjectKey: 'pr:zts212653/cat-cafe#9999' } },
      { ...valid.proof, task: { ...valid.proof.task, generation: 0 } },
      { ...valid.proof, predicate: { ...valid.proof.predicate, triggerCommentId: 0 } },
    ];
    for (const proof of forgedProofs) {
      assert.equal(isEventBackedRoutingBypassProofValid({ ...valid, proof }, identity), false);
    }
  });

  test('a wait without the correlated review-result predicate does not bypass', async () => {
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
