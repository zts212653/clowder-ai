import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canonicalTestMessageInput, canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

const { resolveQueueEntrySettlement } = await import(
  '../dist/domains/cats/services/agents/invocation/queue-entry-settlement.js'
);
const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { createInitialQueuedMessageCustody, QueuedMessageCustodyCoordinator } = await import(
  '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js'
);
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

function enqueue(queue, overrides = {}) {
  const result = queue.enqueue(
    canonicalTestQueueInput({
      threadId: 'thread-settlement',
      userId: 'user-settlement',
      kind: 'conversation_input',
      ownerAuthProvenance: 'strict',
      content: 'durable work',
      source: 'connector',
      sourceCategory: 'scheduled',
      targetCats: ['codex-sol'],
      intent: 'execute',
      autoExecute: true,
      ...overrides,
    }),
  );
  assert.equal(result.outcome, 'enqueued');
  return result.entry;
}

describe('Queue entry settlement decision', () => {
  test('maps terminal reason, replacement proof and action fence to one disposition', () => {
    const cases = [
      [{ terminalReason: 'succeeded', replacement: { kind: 'none' }, actionFence: { kind: 'none' } }, 'consume'],
      [{ terminalReason: 'user_cancel', replacement: { kind: 'none' }, actionFence: { kind: 'none' } }, 'consume'],
      [
        {
          terminalReason: 'system_failure',
          replacement: { kind: 'none' },
          actionFence: { kind: 'none' },
          custody: 'durable',
        },
        'consume',
      ],
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

  test('durable failure terminalizes the source instead of restoring the same Queue attempt', async () => {
    const queue = new InvocationQueue();
    const store = new MessageStore();
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: store });
    const entry = enqueue(queue);
    const message = store.append(
      canonicalTestMessageInput({
        threadId: entry.threadId,
        userId: entry.userId,
        catId: null,
        content: entry.content,
        mentions: entry.targetCats,
        timestamp: entry.createdAt,
        deliveryStatus: 'queued',
      }),
    );
    queue.backfillMessageId(entry.threadId, entry.userId, entry.id, message.id);
    const bound = queue.getEntrySnapshot(entry.threadId, entry.userId, entry.id);
    assert.equal(
      store.initializeQueueCustody(message.id, createInitialQueuedMessageCustody(bound)).kind,
      'initialized',
    );

    const failedAt = entry.createdAt + 10;
    const settlement = await coordinator.commitFailedTargets(bound, ['codex-sol'], failedAt, 'invocation_failed', {
      'codex-sol': 'inv-failed-1',
    });

    assert.deepEqual(settlement.perMessage, [
      {
        messageId: message.id,
        failedTargetCats: ['codex-sol'],
        pendingTargetCats: [],
        fullyConsumed: true,
      },
    ]);
    const persisted = await store.getById(message.id);
    assert.equal(persisted.deliveryStatus, 'delivered');
    assert.equal(persisted.deliveredAt, failedAt);
    assert.equal(persisted.queueCustody.status, 'terminal');
    assert.deepEqual(persisted.queueCustody.pendingTargetCats, []);
    assert.deepEqual(persisted.queueCustody.failedByCatIds, ['codex-sol']);
    assert.deepEqual(persisted.queueCustody.targetAttempts, [
      {
        id: `${entry.id}:codex-sol:1`,
        targetCatId: 'codex-sol',
        sequence: 1,
        state: 'failed',
        createdAt: entry.createdAt,
        updatedAt: failedAt,
        invocationId: 'inv-failed-1',
        terminalReason: 'invocation_failed',
      },
    ]);
  });
});

describe('verified Queue custody replacement', () => {
  test('atomically rebinds the queued source from an absent old entry to one exact replacement', async () => {
    const queue = new InvocationQueue();
    const store = new MessageStore();
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: store });
    const oldEntry = enqueue(queue);
    const message = store.append(
      canonicalTestMessageInput({
        threadId: oldEntry.threadId,
        userId: oldEntry.userId,
        catId: null,
        content: oldEntry.content,
        mentions: oldEntry.targetCats,
        timestamp: oldEntry.createdAt,
        deliveryStatus: 'queued',
      }),
    );
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
    const message = store.append(
      canonicalTestMessageInput({
        threadId: oldEntry.threadId,
        userId: oldEntry.userId,
        catId: null,
        content: oldEntry.content,
        mentions: oldEntry.targetCats,
        timestamp: oldEntry.createdAt,
        deliveryStatus: 'queued',
      }),
    );
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
