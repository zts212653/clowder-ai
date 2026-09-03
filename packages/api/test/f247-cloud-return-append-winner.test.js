import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { MemoryCloudReturnGrantStore } from '../dist/domains/cats/services/cloud-bridge/cloud-return-grant.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

describe('F247 atomic append-winner recovery', () => {
  it('routes only from the persisted message when the pre-read misses an idempotency winner', async () => {
    process.env.DEFAULT_OWNER_USER_ID = 'alice';
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const agentKeyRegistry = new AgentKeyRegistry({ ttlMs: 86_400_000 });
    const grantStore = new MemoryCloudReturnGrantStore();
    const store = new MessageStore();
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('alice', 'F247 append winner recovery');
    const source = store.append({
      userId: 'alice',
      catId: 'codex-sol',
      threadId: thread.id,
      content: '@gpt-pro persist routing for this source',
      mentions: ['gpt-pro'],
      timestamp: 2_000,
    });
    const scope = {
      threadId: thread.id,
      userId: 'alice',
      sourceMessageId: source.id,
      targetCatId: 'gpt-pro',
    };
    const idempotencyKey = `f247-cloud-return:${createHash('sha256')
      .update(JSON.stringify({ v: 1, ...scope }))
      .digest('hex')}`;
    const persisted = store.append({
      userId: 'alice',
      catId: 'gpt-pro',
      threadId: thread.id,
      content: 'append winner persisted return',
      mentions: ['codex'],
      origin: 'callback',
      timestamp: 2_100,
      extra: { isExplicitPost: true, targetCats: ['codex'] },
      replyTo: source.id,
      deliveryStatus: 'queued',
      idempotencyKey,
    });
    const getByIdempotencyKey = store.getByIdempotencyKey.bind(store);
    let lookupCount = 0;
    store.getByIdempotencyKey = (...args) => {
      lookupCount += 1;
      return lookupCount === 1 ? null : getByIdempotencyKey(...args);
    };
    await grantStore.issue({ ...scope, dispatchInvocationId: 'dispatch-f247-append-winner' });

    const invocationQueue = new InvocationQueue();
    const broadcasts = [];
    const { secret } = await agentKeyRegistry.issue('gpt-pro', 'alice');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry: new InvocationRegistry(),
      agentKeyRegistry,
      cloudReturnGrantStore: grantStore,
      messageStore: store,
      threadStore,
      socketManager: {
        broadcastAgentMessage: (message) => broadcasts.push(message),
        emitToUser: () => undefined,
      },
      invocationQueue,
      queueProcessor: {
        async onInvocationComplete() {},
        async tryAutoExecute() {},
        registerEntryCompleteHook() {},
        unregisterEntryCompleteHook() {},
      },
      invocationRecordStore: {
        create: () => ({ outcome: 'created', invocationId: 'inv-f247-append-winner' }),
        update: () => undefined,
      },
      router: {
        async *routeExecution() {
          yield { type: 'done', catId: 'codex', isFinal: true, timestamp: Date.now() };
        },
      },
    });

    const retry = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: {
        content: 'append loser retry body with no routing',
        threadId: thread.id,
        replyTo: source.id,
      },
    });

    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().status, 'duplicate');
    assert.equal(retry.json().messageId, persisted.id);
    const entries = invocationQueue.list(thread.id, 'alice');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].messageId, persisted.id);
    assert.deepEqual(entries[0].targetCats, ['codex']);
    assert.equal(entries[0].content, persisted.content);
    assert.equal(broadcasts.length, 0);
    await app.close();
  });
});
