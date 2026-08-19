import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import { WaitContinuationRetryCommitter } from '../dist/domains/ball-custody/WaitContinuationRetryCommitter.js';
import { WaitContinuationRetryPreflight } from '../dist/domains/ball-custody/WaitContinuationRetryPreflight.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

const TARGET_CAT_ID = 'codex-sol';

function waitOutcome(ownerFence, overrides = {}) {
  return {
    v: 1,
    outcomeId: 'wait:pr:zts212653/cat-cafe#1:g4:matched',
    generation: 4,
    subjectRef: 'pr:zts212653/cat-cafe#1',
    ownerFence,
    reason: 'matched',
    at: 1_000,
    delivery: 'delivered',
    nextStep: 'continue exact work',
    ...overrides,
  };
}

function waitTask(ownerFence, overrides = {}) {
  return {
    id: 'task-wait-1',
    kind: 'pr_tracking',
    threadId: 'thread-1',
    subjectKey: 'pr:zts212653/cat-cafe#1',
    title: 'wait',
    ownerCatId: TARGET_CAT_ID,
    status: 'done',
    why: 'test',
    createdBy: TARGET_CAT_ID,
    createdAt: 1,
    updatedAt: 2,
    userId: 'user-1',
    automationState: { waitOutcome: waitOutcome(ownerFence) },
    ...overrides,
  };
}

function processorDeps(queue, messageStore, queueCustodyCoordinator) {
  return {
    queue,
    messageStore,
    queueCustodyCoordinator,
    invocationTracker: {
      start: mock.fn(() => new AbortController()),
      startAll: mock.fn(() => new AbortController()),
      complete: mock.fn(),
      completeAll: mock.fn(),
      has: mock.fn(() => false),
    },
    invocationRecordStore: {
      create: mock.fn(async () => ({ outcome: 'created', invocationId: 'inv-stub' })),
      update: mock.fn(async () => {}),
    },
    router: {
      routeExecution: mock.fn(async function* () {
        yield { type: 'done', catId: TARGET_CAT_ID, timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    },
    socketManager: {
      broadcastAgentMessage: mock.fn(),
      broadcastToRoom: mock.fn(),
      emitToUser: mock.fn(),
    },
    log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
  };
}

async function failedWaitFixture({ ownerFence, leaseResult }) {
  const queue = new InvocationQueue();
  const messageStore = new MessageStore();
  const queued = queue.enqueue({
    threadId: 'thread-1',
    userId: 'user-1',
    content: 'retry the exact wait continuation',
    source: 'agent',
    ownerAuthProvenance: 'strict',
    targetCats: [TARGET_CAT_ID],
    intent: 'execute',
    callerCatId: 'system',
  });
  assert.equal(queued.outcome, 'enqueued');
  assert.ok(queued.entry);
  const entry = queued.entry;
  const message = messageStore.append({
    threadId: entry.threadId,
    userId: entry.userId,
    catId: 'system',
    content: entry.content,
    mentions: entry.targetCats,
    timestamp: entry.createdAt,
    deliveryStatus: 'queued',
    source: {
      connector: 'github-wait',
      meta: {
        waitContinuationCarrier: {
          v: 1,
          waitId: 'task-wait-1',
          outcomeId: 'wait:pr:zts212653/cat-cafe#1:g4:matched',
          ownerFence,
        },
      },
    },
    queueCustody: createInitialQueuedMessageCustody(entry),
  });
  queue.backfillMessageId(entry.threadId, entry.userId, entry.id, message.id);

  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore });
  queue.markQueuedSeen(entry.threadId, entry.userId, entry.id, TARGET_CAT_ID, 'inv-failed');
  queue.markQueuedFailedForCatAcrossUsers(
    entry.threadId,
    TARGET_CAT_ID,
    'inv-failed',
    new Set([entry.id]),
    'invocation_failed',
  );
  await coordinator.persistEntry(queue.getEntrySnapshot(entry.threadId, entry.userId, entry.id));

  let currentTask = waitTask(ownerFence);
  let currentLeaseResult = leaseResult;
  const taskStore = { get: () => currentTask };
  const actionSuccessorLeaseStore = {
    preflightOutput: () => currentLeaseResult,
  };
  const preflight = new WaitContinuationRetryPreflight({
    taskStore,
    actionSuccessorLeaseStore,
  });
  const revalidateAuthority = async () => {
    const currentMessage = messageStore.getById(message.id);
    assert.ok(currentMessage);
    return preflight.preflight({
      message: currentMessage,
      requestingUserId: entry.userId,
      targetCatId: TARGET_CAT_ID,
    });
  };
  const committer = new WaitContinuationRetryCommitter({ messageStore, taskStore, actionSuccessorLeaseStore });
  let beforeCommit;
  const commitAuthority = async (transitions) => {
    beforeCommit?.();
    return committer.commit({
      authorityMessageId: message.id,
      requestingUserId: entry.userId,
      targetCatId: TARGET_CAT_ID,
      transitions,
    });
  };
  const failedAttempt = messageStore.getById(message.id).queueCustody.targetAttempts[0];
  assert.equal(failedAttempt.state, 'failed');

  return {
    entry,
    failedAttempt,
    message,
    messageStore,
    processor: new QueueProcessor(processorDeps(queue, messageStore, coordinator)),
    queue,
    commitAuthority,
    revalidateAuthority,
    replaceTask: (next) => {
      currentTask = next;
    },
    replaceLeaseResult: (next) => {
      currentLeaseResult = next;
    },
    setBeforeCommit: (hook) => {
      beforeCommit = hook;
    },
  };
}

function assertRetryWasNotMinted(fixture) {
  const queueEntry = fixture.queue.getEntrySnapshot(fixture.entry.threadId, fixture.entry.userId, fixture.entry.id);
  assert.deepEqual(queueEntry.queuedFailedByCatIds, [TARGET_CAT_ID]);
  const custody = fixture.messageStore.getById(fixture.message.id).queueCustody;
  assert.deepEqual(
    custody.targetAttempts.map(({ id, state }) => ({ id, state })),
    [{ id: fixture.failedAttempt.id, state: 'failed' }],
  );
}

describe('Gate 5 retry authority mutation linearization', () => {
  test('containing-task replacement after route preflight cannot reopen Queue or append an attempt', async () => {
    const ownerFence = { kind: 'containing_task', generation: 4 };
    const fixture = await failedWaitFixture({ ownerFence, leaseResult: { ok: true, reason: 'active' } });
    assert.deepEqual(await fixture.revalidateAuthority(), { ok: true, kind: 'wait_containing_task' });

    fixture.replaceTask(
      waitTask(
        { kind: 'containing_task', generation: 5 },
        {
          automationState: { waitOutcome: waitOutcome({ kind: 'containing_task', generation: 5 }, { generation: 5 }) },
        },
      ),
    );
    const result = await fixture.processor.retryFailedTarget(
      fixture.entry.threadId,
      fixture.entry.userId,
      fixture.entry.id,
      TARGET_CAT_ID,
      fixture.failedAttempt.id,
      fixture.commitAuthority,
    );

    assert.deepEqual(result, { outcome: 'authority_stale', reason: 'outcome_mismatch' });
    assertRetryWasNotMinted(fixture);
  });

  test('action-successor terminalization after route preflight cannot reopen Queue or append an attempt', async () => {
    const ownerFence = { kind: 'action_successor', leaseId: 'lease-1', generation: 7 };
    const fixture = await failedWaitFixture({ ownerFence, leaseResult: { ok: true, reason: 'active' } });
    assert.deepEqual(await fixture.revalidateAuthority(), { ok: true, kind: 'wait_action_successor' });

    fixture.replaceLeaseResult({ ok: false, reason: 'holder_terminal' });
    const result = await fixture.processor.retryFailedTarget(
      fixture.entry.threadId,
      fixture.entry.userId,
      fixture.entry.id,
      TARGET_CAT_ID,
      fixture.failedAttempt.id,
      fixture.commitAuthority,
    );

    assert.deepEqual(result, { outcome: 'authority_stale', reason: 'holder_terminal' });
    assertRetryWasNotMinted(fixture);
  });

  test('containing-task replacement immediately before authority commit cannot mint the custody attempt', async () => {
    const ownerFence = { kind: 'containing_task', generation: 4 };
    const fixture = await failedWaitFixture({ ownerFence, leaseResult: { ok: true, reason: 'active' } });
    let revoked = false;
    fixture.setBeforeCommit(() => {
      if (!revoked) {
        revoked = true;
        fixture.replaceTask(
          waitTask(
            { kind: 'containing_task', generation: 5 },
            {
              automationState: {
                waitOutcome: waitOutcome({ kind: 'containing_task', generation: 5 }, { generation: 5 }),
              },
            },
          ),
        );
      }
    });

    const result = await fixture.processor.retryFailedTarget(
      fixture.entry.threadId,
      fixture.entry.userId,
      fixture.entry.id,
      TARGET_CAT_ID,
      fixture.failedAttempt.id,
      fixture.commitAuthority,
    );

    assert.equal(revoked, true, 'the deterministic race must revoke immediately before the custody CAS');
    assert.deepEqual(result, { outcome: 'authority_stale', reason: 'outcome_mismatch' });
    assertRetryWasNotMinted(fixture);
  });

  test('action-successor terminalization immediately before authority commit cannot mint the custody attempt', async () => {
    const ownerFence = { kind: 'action_successor', leaseId: 'lease-1', generation: 7 };
    const fixture = await failedWaitFixture({ ownerFence, leaseResult: { ok: true, reason: 'active' } });
    let revoked = false;
    fixture.setBeforeCommit(() => {
      if (!revoked) {
        revoked = true;
        fixture.replaceLeaseResult({ ok: false, reason: 'holder_terminal' });
      }
    });

    const result = await fixture.processor.retryFailedTarget(
      fixture.entry.threadId,
      fixture.entry.userId,
      fixture.entry.id,
      TARGET_CAT_ID,
      fixture.failedAttempt.id,
      fixture.commitAuthority,
    );

    assert.equal(revoked, true, 'the deterministic race must revoke immediately before the custody CAS');
    assert.deepEqual(result, { outcome: 'authority_stale', reason: 'holder_terminal' });
    assertRetryWasNotMinted(fixture);
  });
});
