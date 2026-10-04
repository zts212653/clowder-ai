import assert from 'node:assert/strict';
import { ManagedCommandWakeRecoverySweep } from '../../dist/domains/ball-custody/ManagedCommandWakeRecoverySweep.js';
import { ManagedHoldReceiptService } from '../../dist/domains/ball-custody/ManagedHoldReceiptService.js';
import { createManagedCommandWakeQueueAdapter } from '../../dist/domains/ball-custody/managed-command-wake-queue-adapter.js';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { QueueProcessor } from '../../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';

/** Real Queue/receipt/sweep consumers for a route's actual missing-disposition output. */
export async function managedWakeRouteRecoveryFixture(threadId, catId, taskId) {
  const userId = 'user1';
  const invocationId = 'outer-inv-1';
  const now = Date.now();
  const queue = new InvocationQueue();
  const messageStore = new MessageStore();
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore, now: () => now + 3000 });
  const admission = queue.enqueue({
    threadId,
    userId,
    ownerAuthProvenance: 'strict',
    content: 'command done',
    source: 'connector',
    sourceCategory: 'scheduled',
    targetCats: [catId],
    intent: 'execute',
    autoExecute: true,
  });
  const message = messageStore.append({
    threadId,
    userId: 'scheduler',
    catId: null,
    content: 'command done',
    mentions: [catId],
    timestamp: now,
    deliveryStatus: 'queued',
    source: { connector: 'hold-ball', meta: { wakeWhen: true, taskId, threadId, catId } },
  });
  const entryId = admission.entry.id;
  queue.backfillMessageId(threadId, userId, entryId, message.id);
  messageStore.initializeQueueCustody(
    message.id,
    createInitialQueuedMessageCustody(queue.getEntrySnapshot(threadId, userId, entryId)),
  );
  queue.markQueuedSeen(threadId, userId, entryId, catId, invocationId, now + 1000);
  await coordinator.persistEntry(queue.getEntrySnapshot(threadId, userId, entryId));
  let task = {
    id: taskId,
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: now },
    params: {
      targetCatId: catId,
      triggerUserId: userId,
      holdLifecycle: {
        mode: 'wake_when',
        status: 'active',
        createdBy: `hold-ball:${catId}`,
        managedCommand: { state: 'enqueued', command: 'pnpm test', startedAt: now, messageId: message.id },
      },
    },
    deliveryThreadId: threadId,
    enabled: true,
    createdBy: `hold-ball:${catId}`,
    createdAt: new Date(now).toISOString(),
  };
  const dynamicTaskStore = {
    getById: (id) => (id === taskId ? task : null),
    getAll: () => [task],
    updateParamsIfCurrent(id, expected, params) {
      if (id !== taskId || task.params !== expected) return false;
      task = { ...task, params };
      return true;
    },
    setEnabled(_id, enabled) {
      task = { ...task, enabled };
    },
  };
  const queueProcessor = new QueueProcessor({
    queue,
    messageStore,
    queueCustodyCoordinator: coordinator,
    invocationTracker: { has: () => true },
    socketManager: { emitToUser() {}, broadcastToRoom() {}, broadcastAgentMessage() {} },
    log: { info() {}, warn() {}, error() {} },
  });
  return {
    messageId: message.id,
    messageStore,
    async settle() {
      const receipt = new ManagedHoldReceiptService({ queue, messageStore, coordinator });
      await receipt.complete({
        threadId,
        userId,
        catId,
        invocationId,
        sourceMessageId: message.id,
        taskId,
        handledAt: now + 2000,
      });
      assert.deepEqual(messageStore.getById(message.id).queueCustody.handledByCatIds, [catId]);
    },
    async withdraw() {
      const entry = queue.getEntrySnapshot(threadId, userId, entryId);
      assert.equal(await coordinator.withdrawEntry(entry), true);
      assert.equal(queue.removeEntrySnapshotIfUnchanged(entry), true);
      assert.deepEqual(messageStore.getById(message.id).queueCustody.withdrawnByCatIds, [catId]);
    },
    async assertRecovery(done) {
      queue.markQueuedFailedForCatAcrossUsers(
        threadId,
        catId,
        invocationId,
        new Set([entryId]),
        'invocation_failed',
        now + 2000,
      );
      await coordinator.persistEntry(queue.getEntrySnapshot(threadId, userId, entryId));
      const adapter = createManagedCommandWakeQueueAdapter({
        dynamicTaskStore,
        messageStore,
        invocationQueue: queue,
        queueProcessor,
        // Mirrors the terminal record consumer: error comes from the real route,
        // not a fixture hard-coded managed_hold_disposition_missing string.
        invocationRecordStore: { get: async () => ({ id: invocationId, status: 'failed', error: done.errorCode }) },
      });
      const sweep = new ManagedCommandWakeRecoverySweep({
        dynamicTaskStore,
        messageStore,
        ...adapter,
        taskRunner: { unregister() {} },
        invocationRecordStore: { getByIdempotencyKey: async () => null },
        getInvokeTrigger: () => {
          throw new Error('must retry the existing carrier');
        },
        now: () => now + 3000,
      });
      await sweep.recoverTask(taskId);
      assert.equal(task.params.holdLifecycle.managedCommand.dispositionRetryCount, 1);
      assert.deepEqual(
        messageStore.getById(message.id).queueCustody.targetAttempts.map((attempt) => attempt.state),
        ['failed', 'queued'],
      );
      await sweep.recoverTask(taskId);
      assert.equal(
        messageStore.getById(message.id).queueCustody.targetAttempts.length,
        2,
        'bounded retry never duplicates a pending carrier',
      );
    },
  };
}
