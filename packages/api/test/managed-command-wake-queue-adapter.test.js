import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createManagedCommandWakeQueueAdapter } from '../dist/domains/ball-custody/managed-command-wake-queue-adapter.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { canonicalTestMessageInput, canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

test('managed wake adapter retries one exact failed disposition attempt under its durable owner', async () => {
  const threadId = 'thread-managed-adapter';
  const userId = 'user-owner';
  const catId = 'codex-sol';
  const taskId = 'hold-ball-managed-adapter';
  const invocationId = 'invocation-missing-disposition';
  const startedAt = Date.now();
  const queue = new InvocationQueue();
  const messageStore = new MessageStore();
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore, now: () => startedAt + 3_000 });
  const admission = queue.enqueue(
    canonicalTestQueueInput({
      kind: 'conversation_input',
      threadId,
      userId,
      ownerAuthProvenance: 'strict',
      content: '[managed wake] command complete',
      source: 'connector',
      sourceCategory: 'scheduled',
      targetCats: [catId],
      intent: 'execute',
      autoExecute: true,
    }),
  );
  assert.equal(admission.outcome, 'enqueued');
  const message = messageStore.append(
    canonicalTestMessageInput({
      threadId,
      userId: 'scheduler',
      catId: null,
      content: admission.entry.content,
      mentions: [catId],
      timestamp: startedAt,
      deliveryStatus: 'queued',
      source: {
        connector: 'hold-ball',
        label: 'managed wake',
        icon: '⏱️',
        meta: { wakeWhen: true, taskId },
      },
    }),
  );
  queue.backfillMessageId(threadId, userId, admission.entry.id, message.id);
  const entry = queue.getEntrySnapshot(threadId, userId, admission.entry.id);
  assert.equal(
    messageStore.initializeQueueCustody(message.id, createInitialQueuedMessageCustody(entry)).kind,
    'initialized',
  );
  queue.markQueuedSeen(threadId, userId, entry.id, catId, invocationId, startedAt + 2_000);
  await coordinator.persistEntry(queue.getEntrySnapshot(threadId, userId, entry.id));
  const [failed] = queue.takeQueuedFailedTargetForCatAcrossUsers(
    threadId,
    catId,
    invocationId,
    new Set([entry.id]),
    'invocation_failed',
    startedAt + 2_100,
  );
  assert.ok(failed?.entrySnapshot);
  await coordinator.commitFailedTargets(failed.entrySnapshot, [catId], startedAt + 2_100, 'invocation_failed', {
    [catId]: invocationId,
  });

  const task = {
    id: taskId,
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: startedAt + 99_000 },
    params: {
      triggerUserId: userId,
      holdLifecycle: {
        mode: 'wake_when',
        status: 'active',
        createdBy: `hold-ball:${catId}`,
        managedCommand: {
          state: 'enqueued',
          command: 'pnpm gate',
          startedAt,
          messageId: message.id,
        },
      },
    },
    display: { label: 'hold', category: 'system', description: 'hold' },
    deliveryThreadId: threadId,
    enabled: true,
    createdBy: `hold-ball:${catId}`,
    createdAt: new Date(startedAt).toISOString(),
  };
  const queueProcessor = {
    async retryFailedTarget(
      expectedThreadId,
      expectedUserId,
      previousEntryId,
      sourceMessageId,
      targetCatId,
      expectedAttemptId,
      commit,
    ) {
      const currentMessage = messageStore.getById(sourceMessageId);
      if (currentMessage?.queueCustody?.entryId !== previousEntryId) return { outcome: 'not_retryable' };
      const admissionId = `retry-test:${sourceMessageId}:${expectedAttemptId}`;
      const replacement = queue.enqueue(
        canonicalTestQueueInput({
          kind: 'conversation_input',
          threadId: expectedThreadId,
          userId: expectedUserId,
          ownerAuthProvenance: currentMessage.queueCustody.ownerAuthProvenance,
          content: currentMessage.content,
          messageId: sourceMessageId,
          source: 'connector',
          targetCats: [targetCatId],
          intent: currentMessage.queueCustody.intent,
          priority: 'urgent',
          queueCustodyAdmissionId: admissionId,
        }),
      ).entry;
      const retried = await coordinator.retryFailedTarget(replacement, targetCatId, expectedAttemptId, commit);
      if (retried.outcome !== 'retried') return retried;
      assert.equal(
        queue.commitQueueCustodyAdmission(expectedThreadId, expectedUserId, admissionId, [replacement.id]),
        true,
      );
      queue.bindRetryAttemptId(expectedThreadId, expectedUserId, replacement.id, targetCatId, retried.attempt.id);
      return { outcome: 'retried', attemptId: retried.attempt.id, entryId: replacement.id };
    },
  };
  const adapter = createManagedCommandWakeQueueAdapter({
    dynamicTaskStore: { getById: (id) => (id === taskId ? task : null) },
    messageStore,
    invocationRecordStore: {
      async get(id) {
        return id === invocationId ? { id, status: 'failed', error: 'managed_hold_disposition_missing' } : null;
      },
    },
    invocationQueue: queue,
    queueProcessor,
  });

  const failedCarrier = await adapter.getEventCarrier({ threadId, userId, catId, messageId: message.id });
  assert.deepEqual(failedCarrier, {
    state: 'failed',
    attemptId: `${entry.id}:${catId}:1`,
    attemptSequence: 1,
    invocationId,
    errorCode: 'managed_hold_disposition_missing',
  });
  assert.equal(
    await adapter.retryEventCarrier({
      taskId,
      threadId,
      userId,
      catId,
      messageId: message.id,
      attemptId: failedCarrier.attemptId,
    }),
    'retried',
  );
  const retriedCustody = messageStore.getById(message.id).queueCustody;
  assert.equal(retriedCustody.ownerUserId, userId);
  assert.deepEqual(
    retriedCustody.targetAttempts.map(({ id, state }) => ({ id, state })),
    [
      { id: `${entry.id}:${catId}:1`, state: 'failed' },
      { id: `${retriedCustody.entryId}:${catId}:2`, state: 'queued' },
    ],
  );
  assert.notEqual(retriedCustody.entryId, entry.id);
  assert.equal(
    await adapter.retryEventCarrier({
      taskId,
      threadId,
      userId: 'user-foreign',
      catId,
      messageId: message.id,
      attemptId: failedCarrier.attemptId,
    }),
    'not_retryable',
  );
});
