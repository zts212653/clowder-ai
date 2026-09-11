import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('cloud delivery retry', () => {
  let app;
  let messageStore;
  let invocationQueue;
  let drainRequests;

  beforeEach(async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { InMemoryQueueLedgerStore } = await import(
      '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js'
    );
    const { messagesRoutes } = await import('../dist/routes/messages.js');

    messageStore = new MessageStore();
    invocationQueue = new InvocationQueue(new InMemoryQueueLedgerStore());
    drainRequests = [];
    app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore,
      invocationQueue,
      queueProcessor: {
        requestDrain(threadId) {
          drainRequests.push(threadId);
        },
      },
      socketManager: { emitToUser() {} },
      router: {
        async resolveExplicitTargets(targets) {
          return targets.includes('gpt-pro') ? [...targets] : [];
        },
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
  });

  function seedRecoverableSource() {
    const source = messageStore.append({
      from: { kind: 'user', userId: 'default-user' },
      userId: 'default-user',
      threadId: 'thread-cloud-retry',
      content: '@gpt-pro please retry this exact body',
      contentBlocks: [{ type: 'text', text: '@gpt-pro please retry this exact body' }],
      mentions: ['gpt-pro'],
      timestamp: 1_000,
    });
    messageStore.append({
      from: { kind: 'system', service: 'system-info-warning' },
      userId: 'system',
      threadId: source.threadId,
      content: '这条消息还没有发送',
      mentions: [],
      timestamp: 1_100,
      replyTo: source.id,
      source: {
        connector: 'cloud-bridge-status',
        label: '云端猫投递',
        icon: '⚠️',
        meta: {
          cloudBridgeRecovery: {
            v: 1,
            kind: 'needs_binding',
            sourceMessageId: source.id,
            targetCatId: 'gpt-pro',
            dispatchInvocationId: 'dispatch-failed-1',
          },
        },
      },
    });
    return source;
  }

  it('creates one new hidden source and pending Queue attempt without mutating the failed source', async () => {
    const source = seedRecoverableSource();
    const response = await app.inject({
      method: 'POST',
      url: `/api/messages/${source.id}/delivery-targets/gpt-pro/retry`,
      payload: { attemptId: 'dispatch-failed-1' },
    });

    assert.equal(response.statusCode, 202, response.body);
    const body = response.json();
    assert.notEqual(body.retryMessageId, source.id);
    assert.equal((await messageStore.getById(source.id)).content, source.content);
    const retry = await messageStore.getById(body.retryMessageId);
    assert.equal(retry.deliveryStatus, 'queued');
    assert.equal(retry.content, source.content);
    assert.deepEqual(retry.contentBlocks, source.contentBlocks);
    assert.deepEqual(retry.mentions, ['gpt-pro']);
    const [entry] = invocationQueue.list(source.threadId, 'default-user');
    assert.equal(entry.payload.sourceRecordId, retry.id);
    assert.deepEqual(entry.targets, ['gpt-pro']);
    assert.deepEqual(drainRequests, [source.threadId]);
  });

  it('rejects a forged attempt and does not create Queue work', async () => {
    const source = seedRecoverableSource();
    const response = await app.inject({
      method: 'POST',
      url: `/api/messages/${source.id}/delivery-targets/gpt-pro/retry`,
      payload: { attemptId: 'different-attempt' },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'DELIVERY_RETRY_AUTHORITY_STALE');
    assert.deepEqual(invocationQueue.list(source.threadId, 'default-user'), []);
  });

  it('allows one retry per failed delivery attempt', async () => {
    const source = seedRecoverableSource();
    const request = {
      method: 'POST',
      url: `/api/messages/${source.id}/delivery-targets/gpt-pro/retry`,
      payload: { attemptId: 'dispatch-failed-1' },
    };
    assert.equal((await app.inject(request)).statusCode, 202);
    const replay = await app.inject(request);
    assert.equal(replay.statusCode, 409);
    assert.equal(replay.json().code, 'DELIVERY_RETRY_AUTHORITY_STALE');
    assert.equal(invocationQueue.list(source.threadId, 'default-user').length, 1);
  });
});
