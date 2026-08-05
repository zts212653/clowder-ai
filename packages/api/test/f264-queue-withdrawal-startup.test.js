import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { createInitialQueuedMessageCustody } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { QueuedMessageCustodyStartupReconciler } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupReconciler.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

describe('F264 withdrawn Queue custody startup recovery', () => {
  test('keeps terminal withdrawn author history queued without restoring actionable work', async () => {
    const queue = new InvocationQueue();
    const admitted = queue.enqueue({
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'keep this in my timeline',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
      ownerAuthProvenance: 'strict',
    });
    assert.equal(admitted.outcome, 'enqueued');
    const custody = {
      ...createInitialQueuedMessageCustody(admitted.entry),
      revision: 2,
      status: 'terminal',
      pendingTargetCats: [],
      withdrawnByCatIds: ['opus'],
      withdrawnAtByCatId: { opus: admitted.entry.createdAt + 100 },
      updatedAt: admitted.entry.createdAt + 100,
    };
    const store = new MessageStore();
    const message = store.append({
      threadId: admitted.entry.threadId,
      userId: admitted.entry.userId,
      catId: null,
      content: admitted.entry.content,
      mentions: admitted.entry.targetCats,
      timestamp: admitted.entry.createdAt,
      deliveryStatus: 'queued',
      queueCustody: custody,
    });
    store.scanByDeliveryStatus = async (status) => (status === 'queued' ? [message.id] : []);
    const recoveredQueue = new InvocationQueue();
    const reconciler = new QueuedMessageCustodyStartupReconciler({
      messageStore: store,
      invocationRecordStore: { get: async () => undefined },
      invocationQueue: recoveredQueue,
      log: { info() {}, warn() {} },
      now: () => admitted.entry.createdAt + 1_000,
    });

    const result = await reconciler.reconcile();

    assert.equal(result.entriesRestored, 0);
    assert.equal(result.messagesTerminalized, 1);
    assert.equal(result.messagesFailed, 0);
    assert.deepEqual(recoveredQueue.list('thread-1', 'user-1'), []);
    assert.equal(store.getById(message.id)?.deliveryStatus, 'queued');
    assert.equal(store.getById(message.id)?.queueCustody?.status, 'terminal');
  });
});
