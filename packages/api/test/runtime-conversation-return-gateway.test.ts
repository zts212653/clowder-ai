import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RuntimeInteractionRecord } from '@cat-cafe/shared';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { MessageQueueRuntimeConversationReturnGateway } from '../src/domains/runtime-interaction/MessageQueueRuntimeConversationReturnGateway.js';
import './helpers/setup-cat-registry.js';

function conversationRecord(interactionId = 'conversation-1'): RuntimeInteractionRecord {
  return {
    request: {
      version: 1,
      interactionId,
      kind: 'conversation_decision',
      owner: {
        userId: 'user-1',
        threadId: 'thread-1',
        catId: 'codex-sol',
        invocationId: 'requester-invocation',
      },
      createdAt: 1_000,
      title: 'Choose a release name',
      presentation: {
        id: 'decision-block',
        kind: 'interactive',
        v: 1,
        interactiveType: 'select',
        options: [
          { id: 'sunrise', label: 'Sunrise' },
          { id: 'moonrise', label: 'Moonrise' },
        ],
      },
      allowTextResponse: true,
    },
    source: {
      kind: 'conversation_decision',
      requesterCatId: 'codex-sol',
      requesterThreadId: 'thread-1',
      requesterInvocationId: 'requester-invocation',
    },
    returnBinding: { kind: 'conversation_turn', requesterCatId: 'codex-sol', requesterThreadId: 'thread-1' },
    status: 'pending',
    hostEpoch: 'host-1',
    revision: 3,
    cardRef: {
      threadId: 'thread-1',
      messageId: 'decision-card-message',
      blockId: 'decision-block',
      publishedAt: 1_000,
    },
    updatedAt: 1_100,
  };
}

function input(author: 'owner' | 'host' = 'owner') {
  return {
    interactionId: 'conversation-1',
    operationId: 'operation-1',
    author,
    content: 'Release name: Sunrise',
    record: conversationRecord(),
  };
}

function makeHarness(options: { messageStore?: MessageStore; ledger?: InMemoryQueueLedgerStore } = {}) {
  const messageStore = options.messageStore ?? new MessageStore();
  const ledger = options.ledger ?? new InMemoryQueueLedgerStore();
  const queue = new InvocationQueue(ledger);
  const roomEvents: unknown[] = [];
  const userEvents: unknown[] = [];
  const autoExecuteThreads: string[] = [];
  const gateway = new MessageQueueRuntimeConversationReturnGateway({
    messageStore,
    queue,
    socketManager: {
      broadcastToRoom: (room, event, data) => roomEvents.push({ room, event, data }),
      emitToUser: (userId, event, data) => userEvents.push({ userId, event, data }),
    },
    tryAutoExecute: async (threadId) => {
      autoExecuteThreads.push(threadId);
    },
    now: () => 2000,
  });
  return { gateway, messageStore, queue, ledger, roomEvents, userEvents, autoExecuteThreads };
}

class AtomicAcknowledgementLossStore extends MessageStore {
  failOnce = true;
  override appendWithQueueLedgerAdmission(...args: Parameters<MessageStore['appendWithQueueLedgerAdmission']>) {
    const committed = super.appendWithQueueLedgerAdmission(...args);
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error('atomic acknowledgement lost');
    }
    return committed;
  }
}

describe('MessageQueueRuntimeConversationReturnGateway atomic lifecycle integration', () => {
  it('preserves one owner-authored message and one exact target across retries', async () => {
    const h = makeHarness();
    const first = await h.gateway.deliver(input());
    assert.deepEqual(await h.gateway.deliver(input()), first);
    const msg = await h.messageStore.getById(first.messageId);
    assert.deepEqual(msg?.from, { kind: 'user', userId: 'user-1' });
    assert.equal(msg?.source, undefined);
    assert.equal(msg?.replyTo, 'decision-card-message');
    assert.equal(msg?.deliveryStatus, 'queued');
    assert.deepEqual(msg?.extra?.runtimeInteractionReturn, {
      interactionId: 'conversation-1',
      operationId: 'operation-1',
      author: 'owner',
      requesterCatId: 'codex-sol',
      cardMessageId: 'decision-card-message',
    });
    const [entry] = h.queue.list('thread-1', 'user-1');
    assert.equal(h.queue.list('thread-1', 'user-1').length, 1);
    assert.equal(entry?.payload.messageId, first.messageId);
    assert.deepEqual(entry?.targets, ['codex-sol']);
    assert.equal(entry?.execution.ownerAuthProvenance, 'strict');
    assert.equal(entry?.execution.autoExecute, true);
  });

  it('attributes Host returns to system identity without granting owner authority', async () => {
    const h = makeHarness();
    const result = await h.gateway.deliver(input('host'));
    const msg = await h.messageStore.getById(result.messageId);
    assert.deepEqual(msg?.from, { kind: 'system', service: 'runtime-interaction' });
    assert.equal(msg?.source?.connector, 'runtime-interaction');
    const [entry] = h.queue.list('thread-1', 'user-1');
    assert.deepEqual(entry?.targets, ['codex-sol']);
    assert.equal(entry?.execution.ownerAuthProvenance, 'unknown');
    assert.equal(h.roomEvents.length, 1);
  });

  it('recovers an atomic acknowledgement loss with the original durable row', async () => {
    const h = makeHarness({ messageStore: new AtomicAcknowledgementLossStore() });
    await assert.rejects(h.gateway.deliver(input()), /atomic acknowledgement lost/);
    const [committed] = await h.ledger.list('thread-1');
    assert.ok(committed);
    const recovered = await h.gateway.deliver(input());
    assert.equal(recovered.messageId, committed.payload.messageId);
    assert.equal(h.queue.list('thread-1', 'user-1').length, 1);
    assert.equal(h.queue.list('thread-1', 'user-1')[0]?.id, committed.id);
  });

  it('keeps uncertain commits durable when the first recovery lookup also fails', async () => {
    const h = makeHarness({ messageStore: new AtomicAcknowledgementLossStore() });
    await assert.rejects(h.gateway.deliver(input('host')), /atomic acknowledgement lost/);
    const lookup = h.messageStore.getByIdempotencyKey.bind(h.messageStore);
    h.messageStore.getByIdempotencyKey = () => {
      throw new Error('recovery lookup unavailable');
    };
    await assert.rejects(h.gateway.deliver(input('host')), /recovery lookup unavailable/);
    assert.equal((await h.ledger.list('thread-1')).length, 1);
    assert.equal(h.roomEvents.length, 0);
    h.messageStore.getByIdempotencyKey = lookup;
    await h.gateway.deliver(input('host'));
    assert.equal(h.queue.list('thread-1', 'user-1').length, 1);
    assert.equal(h.roomEvents.length, 1);
  });

  it('exposes no dispatchable work before the atomic message/ledger commit', async () => {
    const h = makeHarness();
    const commit = h.messageStore.appendWithQueueLedgerAdmission.bind(h.messageStore);
    let count = 0;
    h.messageStore.appendWithQueueLedgerAdmission = (...args) => {
      count++;
      assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
      assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
      return commit(...args);
    };
    await h.gateway.deliver(input());
    assert.equal(count, 1);
    assert.equal(h.queue.list('thread-1', 'user-1').length, 1);
  });

  it('coalesces concurrent identical requests and rejects a divergent in-flight request', async () => {
    const h = makeHarness();
    const commit = h.messageStore.appendWithQueueLedgerAdmission.bind(h.messageStore);
    let count = 0;
    h.messageStore.appendWithQueueLedgerAdmission = (...args) => {
      count++;
      return commit(...args);
    };
    const first = h.gateway.deliver(input());
    const second = h.gateway.deliver(input());
    await assert.rejects(h.gateway.deliver({ ...input(), content: 'different' }), /in-flight identity conflicts/);
    assert.deepEqual(await first, await second);
    assert.equal(count, 1);
  });

  it('hydrates the same ledger after restart with automatic wake and exact target intact', async () => {
    const first = makeHarness();
    const delivered = await first.gateway.deliver(input());
    const second = makeHarness({ messageStore: first.messageStore, ledger: first.ledger });
    await second.queue.hydrateFromLedger(second.messageStore);
    const [entry] = second.queue.list('thread-1', 'user-1');
    assert.equal(entry?.execution.autoExecute, true);
    assert.deepEqual(entry?.targets, ['codex-sol']);
    assert.deepEqual(await second.gateway.deliver(input()), delivered);
    assert.equal(second.queue.list('thread-1', 'user-1').length, 1);
  });

  it('does not resurrect an already retired Queue row on replay', async () => {
    const h = makeHarness();
    const delivered = await h.gateway.deliver(input());
    const rows = await h.ledger.list('thread-1');
    h.ledger.removeEnqueuedNow(rows);
    const restarted = makeHarness({ messageStore: h.messageStore, ledger: h.ledger });
    await restarted.queue.hydrateFromLedger(h.messageStore);
    assert.deepEqual(await restarted.gateway.deliver(input()), delivered);
    assert.equal((await h.ledger.list('thread-1')).length, 0);
    assert.equal(restarted.queue.list('thread-1', 'user-1').length, 0);
  });

  it('rejects committed collisions in content, author, card binding and requester', async () => {
    const h = makeHarness();
    await h.gateway.deliver(input());
    const differentCard = input();
    differentCard.record.cardRef!.messageId = 'other-card';
    const differentTarget = input();
    differentTarget.record.request.owner.catId = 'opus';
    for (const wrong of [{ ...input(), content: 'different' }, input('host'), differentCard, differentTarget]) {
      await assert.rejects(h.gateway.deliver(wrong), /idempotency key conflicts/);
    }
    assert.equal((await h.ledger.list('thread-1')).length, 1);
  });

  it('refuses unrelated speech using the same idempotency key', async () => {
    const h = makeHarness();
    await h.messageStore.append({
      userId: 'user-1',
      threadId: 'thread-1',
      from: { kind: 'user', userId: 'user-1' },
      content: 'unrelated',
      mentions: [],
      timestamp: 1500,
      idempotencyKey: 'runtime-interaction:return:conversation-1:operation-1',
    });
    await assert.rejects(h.gateway.deliver(input()), /idempotency key conflicts/);
    assert.equal((await h.ledger.list('thread-1')).length, 0);
  });
});
