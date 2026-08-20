import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { resolveQueueEntrySettlement } = await import(
  '../dist/domains/cats/services/agents/invocation/queue-entry-settlement.js'
);
const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { createInitialQueuedMessageCustody, QueuedMessageCustodyCoordinator } = await import(
  '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js'
);
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

function enqueue(queue, overrides = {}) {
  const result = queue.enqueue({
    threadId: 'thread-settlement',
    userId: 'user-settlement',
    ownerAuthProvenance: 'strict',
    content: 'durable work',
    source: 'connector',
    sourceCategory: 'scheduled',
    targetCats: ['codex-sol'],
    intent: 'execute',
    autoExecute: true,
    ...overrides,
  });
  assert.equal(result.outcome, 'enqueued');
  return result.entry;
}

describe('Queue entry settlement decision', () => {
  test('maps terminal reason, replacement proof and action fence to one disposition', () => {
    const cases = [
      [{ terminalReason: 'succeeded', replacement: { kind: 'none' }, actionFence: { kind: 'none' } }, 'consume'],
      [{ terminalReason: 'user_cancel', replacement: { kind: 'none' }, actionFence: { kind: 'none' } }, 'consume'],
      [{ terminalReason: 'system_failure', replacement: { kind: 'none' }, actionFence: { kind: 'none' } }, 'rollback'],
      [
        {
          terminalReason: 'system_failure',
          replacement: { kind: 'none' },
          actionFence: { kind: 'action_successor', leaseId: 'lease-1', generation: 1 },
        },
        'consume',
      ],
      [
        {
          terminalReason: 'system_failure',
          replacement: { kind: 'none' },
          actionFence: { kind: 'none' },
          durableTerminalOwner: {
            kind: 'freshness_supplement',
            supplementId: 'f254-supplement:message-1:1',
          },
        },
        'consume',
      ],
      [
        {
          terminalReason: 'superseded',
          replacement: {
            kind: 'verified',
            previousEntryId: 'entry-old',
            replacementEntryId: 'entry-new',
            sourceMessageId: 'message-1',
          },
          actionFence: { kind: 'none' },
        },
        'transfer',
      ],
      [{ terminalReason: 'superseded', replacement: { kind: 'none' }, actionFence: { kind: 'none' } }, 'retain'],
    ];

    for (const [input, expected] of cases) {
      assert.equal(resolveQueueEntrySettlement(input), expected, JSON.stringify(input));
    }
  });

  test('explicit user cancel wins over a replacement and cannot silently transfer work', () => {
    assert.equal(
      resolveQueueEntrySettlement({
        terminalReason: 'user_cancel',
        replacement: {
          kind: 'verified',
          previousEntryId: 'entry-old',
          replacementEntryId: 'entry-new',
          sourceMessageId: 'message-1',
        },
        actionFence: { kind: 'none' },
      }),
      'consume',
    );
  });
});

describe('verified Queue custody replacement', () => {
  test('atomically rebinds the queued source from an absent old entry to one exact replacement', async () => {
    const queue = new InvocationQueue();
    const store = new MessageStore();
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: store });
    const oldEntry = enqueue(queue);
    const message = store.append({
      threadId: oldEntry.threadId,
      userId: oldEntry.userId,
      catId: null,
      content: oldEntry.content,
      mentions: oldEntry.targetCats,
      timestamp: oldEntry.createdAt,
      deliveryStatus: 'queued',
    });
    queue.backfillMessageId(oldEntry.threadId, oldEntry.userId, oldEntry.id, message.id);
    const boundOld = queue.getEntrySnapshot(oldEntry.threadId, oldEntry.userId, oldEntry.id);
    assert.equal(
      store.initializeQueueCustody(message.id, createInitialQueuedMessageCustody(boundOld)).kind,
      'initialized',
    );
    assert.ok(queue.remove(oldEntry.threadId, oldEntry.userId, oldEntry.id));

    const replacement = enqueue(queue, { content: oldEntry.content, messageId: message.id });
    const proof = {
      kind: 'verified',
      previousEntryId: oldEntry.id,
      replacementEntryId: replacement.id,
      sourceMessageId: message.id,
    };
    assert.equal(await coordinator.transferEntryCustody(replacement, proof), true);

    const rebound = store.getById(message.id);
    assert.equal(rebound.deliveryStatus, 'queued');
    assert.equal(rebound.queueCustody.entryId, replacement.id);
    assert.equal(rebound.queueCustody.status, 'queued');
  });

  test('rejects a forged replacement proof without changing durable custody', async () => {
    const queue = new InvocationQueue();
    const store = new MessageStore();
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: store });
    const oldEntry = enqueue(queue);
    const message = store.append({
      threadId: oldEntry.threadId,
      userId: oldEntry.userId,
      catId: null,
      content: oldEntry.content,
      mentions: oldEntry.targetCats,
      timestamp: oldEntry.createdAt,
      deliveryStatus: 'queued',
    });
    queue.backfillMessageId(oldEntry.threadId, oldEntry.userId, oldEntry.id, message.id);
    const boundOld = queue.getEntrySnapshot(oldEntry.threadId, oldEntry.userId, oldEntry.id);
    assert.equal(
      store.initializeQueueCustody(message.id, createInitialQueuedMessageCustody(boundOld)).kind,
      'initialized',
    );
    const replacement = enqueue(queue, { messageId: message.id, targetCats: ['opus'] });

    await assert.rejects(
      coordinator.transferEntryCustody(replacement, {
        kind: 'verified',
        previousEntryId: 'forged-old-entry',
        replacementEntryId: replacement.id,
        sourceMessageId: message.id,
      }),
      /replacement|custody|target/i,
    );
    assert.equal(store.getById(message.id).queueCustody.entryId, oldEntry.id);
  });
});
