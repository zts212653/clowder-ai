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

function coveredEventWait(overrides = {}) {
  return {
    v: 1,
    invocationId: INVOCATION_ID,
    threadId: THREAD_ID,
    ownerCatId: CAT_ID,
    subjectKey: SUBJECT_KEY,
    expectedSignal: 'review_posted',
    coverage: {
      status: 'covered',
      kind: 'github_review_trigger_eyes',
      triggerCommentId: 4936000000,
      observedAt: 1_783_700_000_000,
    },
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
    automationState: {
      intent: 'review',
      eventWait: coveredEventWait(),
    },
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

describe('F177 event-backed routing exit resolver', () => {
  test('active tracker + same invocation/owner/thread/subject + covered callback grants bypass', async () => {
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
          intent: 'review',
        },
        eventWait: {
          invocationId: INVOCATION_ID,
          ownerCatId: CAT_ID,
          threadId: THREAD_ID,
          subjectKey: SUBJECT_KEY,
          coverageStatus: 'covered',
        },
      },
    });
  });

  test('consumer-side proof validation rejects a forged stale bypass', () => {
    const forged = {
      kind: 'bypass',
      taskId: 'task-pr-2856',
      subjectKey: SUBJECT_KEY,
      expectedSignal: 'review_posted',
      proof: {
        task: {
          kind: 'pr_tracking',
          status: 'done',
          ownerCatId: CAT_ID,
          threadId: THREAD_ID,
          subjectKey: SUBJECT_KEY,
          intent: 'review',
        },
        eventWait: {
          invocationId: INVOCATION_ID,
          ownerCatId: CAT_ID,
          threadId: THREAD_ID,
          subjectKey: SUBJECT_KEY,
          coverageStatus: 'covered',
        },
      },
    };

    assert.equal(
      isEventBackedRoutingBypassProofValid(forged, {
        threadId: THREAD_ID,
        catId: CAT_ID,
        invocationId: INVOCATION_ID,
      }),
      false,
    );
  });

  test('consumer-side proof validation rejects every forged identity/coverage boundary', async () => {
    const valid = await resolve([trackingTask()]);
    assert.equal(valid.kind, 'bypass');
    if (valid.kind !== 'bypass') return;

    const identity = {
      threadId: THREAD_ID,
      catId: CAT_ID,
      invocationId: INVOCATION_ID,
    };
    const forgedProofs = [
      { task: { ...valid.proof.task, ownerCatId: 'opus-48' } },
      { task: { ...valid.proof.task, threadId: 'thread-other' } },
      { task: { ...valid.proof.task, subjectKey: 'pr:zts212653/cat-cafe#9999' } },
      { task: { ...valid.proof.task, intent: 'merge' } },
      { eventWait: { ...valid.proof.eventWait, ownerCatId: 'opus-48' } },
      { eventWait: { ...valid.proof.eventWait, threadId: 'thread-other' } },
      { eventWait: { ...valid.proof.eventWait, subjectKey: 'pr:zts212653/cat-cafe#9999' } },
      { eventWait: { ...valid.proof.eventWait, invocationId: 'inv-old' } },
      { eventWait: { ...valid.proof.eventWait, coverageStatus: 'uncovered' } },
    ];

    for (const patch of forgedProofs) {
      const forged = {
        ...valid,
        proof: {
          task: patch.task ?? valid.proof.task,
          eventWait: patch.eventWait ?? valid.proof.eventWait,
        },
      };
      assert.equal(isEventBackedRoutingBypassProofValid(forged, identity), false);
    }
  });

  test('EYES=0 / uncovered callback does not grant bypass', async () => {
    const task = trackingTask({
      automationState: {
        intent: 'review',
        eventWait: coveredEventWait({
          coverage: {
            status: 'uncovered',
            kind: 'github_review_trigger_eyes',
            triggerCommentId: 4936000000,
            observedAt: 1_783_700_000_000,
            reason: 'review_not_accepted',
          },
        }),
      },
    });
    assert.deepEqual(await resolve([task]), { kind: 'reject', reason: 'coverage_unconfirmed' });
  });

  test('malformed covered callback state has no event-backed routing candidate', async () => {
    const task = trackingTask({
      automationState: {
        intent: 'review',
        eventWait: coveredEventWait({ coverage: { status: 'covered' } }),
      },
    });
    assert.deepEqual(await resolve([task]), { kind: 'reject', reason: 'no_candidate' });
  });

  test('done tracker is stale and does not grant bypass', async () => {
    assert.deepEqual(await resolve([trackingTask({ status: 'done' })]), {
      kind: 'reject',
      reason: 'task_done',
    });
  });

  test('same thread tracker owned by another cat does not grant bypass', async () => {
    assert.deepEqual(await resolve([trackingTask({ ownerCatId: 'opus-47' })]), {
      kind: 'reject',
      reason: 'owner_mismatch',
    });
  });

  test('grant copied from another thread does not grant bypass', async () => {
    const task = trackingTask({
      automationState: {
        intent: 'review',
        eventWait: coveredEventWait({ threadId: 'thread-other' }),
      },
    });
    assert.deepEqual(await resolve([task]), { kind: 'reject', reason: 'thread_mismatch' });
  });

  test('active but unrelated subject does not grant bypass', async () => {
    const task = trackingTask({
      automationState: {
        intent: 'review',
        eventWait: coveredEventWait({ subjectKey: 'pr:zts212653/cat-cafe#9999' }),
      },
    });
    assert.deepEqual(await resolve([task]), { kind: 'reject', reason: 'subject_mismatch' });
  });

  test('grant from an older invocation does not grant bypass', async () => {
    const task = trackingTask({
      automationState: {
        intent: 'review',
        eventWait: coveredEventWait({ invocationId: 'inv-old' }),
      },
    });
    assert.deepEqual(await resolve([task]), { kind: 'reject', reason: 'invocation_mismatch' });
  });

  test('covered review wait retained after switching tracker intent to merge does not grant bypass', async () => {
    const task = trackingTask({
      automationState: {
        intent: 'merge',
        eventWait: coveredEventWait(),
      },
    });
    assert.deepEqual(await resolve([task]), { kind: 'reject', reason: 'intent_mismatch' });
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
