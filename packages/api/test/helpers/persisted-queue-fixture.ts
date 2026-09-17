import assert from 'node:assert/strict';
import { InvocationQueue } from '../../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../../src/domains/cats/services/agents/invocation/InvocationTracker.js';
import { PersistedQueueDelivery } from '../../src/domains/cats/services/agents/invocation/PersistedQueueDelivery.js';
import { QueuedMessageCustodyCoordinator } from '../../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { QueueProcessor } from '../../src/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InvocationRecordStore } from '../../src/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';

/** Real admission, QueueProcessor and durable custody, with a deterministic provider boundary that never calls a model. */
export function createPersistedQueueFixture(messages = new MessageStore()) {
  const queue = new InvocationQueue();
  const tracker = new InvocationTracker();
  const records = new InvocationRecordStore();
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: messages });
  const starts: { threadId: string; userId: string; invocationId: string }[] = [];
  const completed: Promise<void>[] = [];
  const releases: (() => void)[] = [];
  const processor = new QueueProcessor({
    queue,
    invocationTracker: tracker,
    messageStore: messages,
    queueCustodyCoordinator: coordinator,
    invocationRecordStore: {
      async create(input) {
        return records.create(input as Parameters<InvocationRecordStore['create']>[0]);
      },
      get: (id) => records.get(id),
      async update(id, input) {
        return records.update(id, input as Parameters<InvocationRecordStore['update']>[1]);
      },
    },
    socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
    log: { info() {}, warn() {}, error() {} },
    router: {
      async *routeExecution(userId, _content, threadId, _messageId, targets, _intent, options) {
        const invocationId = String(options?.parentInvocationId);
        const catId = targets[0]!;
        starts.push({ threadId, userId, invocationId });
        const startedAt = Date.now();
        yield {
          type: 'system_info',
          catId,
          turnInvocationId: invocationId,
          turnExecutionStartedAt: startedAt,
          timestamp: startedAt,
          extra: { turnExecution: { executionKind: 'ordinary', invocationId, parentInvocationId: invocationId } },
        };
        const exposed = options?.onPromptMessagesExposed;
        assert.equal(typeof exposed, 'function');
        if (typeof exposed === 'function')
          await exposed({
            threadId,
            userId,
            catId,
            invocationId,
            messageIds: options?.persistedPromptMessageIds,
            seenAt: Date.now(),
          });
        let finish!: () => void;
        const settled = new Promise<void>((resolve) => {
          finish = resolve;
        });
        completed.push(settled);
        await new Promise<void>((resolve) => releases.push(resolve));
        // Release the fixture's provider without fabricating a successful work/Task verdict.
        try {
          yield { type: 'done', catId, invocationId, timestamp: Date.now(), isError: true };
        } finally {
          finish();
        }
      },
      async ackCollectedCursors() {},
    },
  });
  const delivery = new PersistedQueueDelivery({
    messages,
    queue,
    progress: (entry, targetCatId) => processor.progressOwnedCarrier(entry, targetCatId),
  });
  async function waitForAwakening(messageId: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const message = messages.getById(messageId);
      const catId = message?.mentions[0];
      const id = catId && message?.queueCustody?.awakenedInvocationIdByCatId?.[catId];
      if (id) {
        assert.ok(records.get(id));
        return id;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.fail('QueueProcessor did not persist the admitted child awakening');
  }
  async function close() {
    releases.splice(0).forEach((release) => release());
    await Promise.all(completed);
  }
  return { queue, tracker, records, coordinator, processor, delivery, messages, starts, waitForAwakening, close };
}
