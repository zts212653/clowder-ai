import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

describe('record-thread-progress callback', () => {
  async function createFixture() {
    const [{ InvocationRegistry }, { ThreadStore }, { MessageStore }, { TaskStore }, routeModule, storeModule] =
      await Promise.all([
        import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'),
        import('../dist/domains/cats/services/stores/ports/ThreadStore.js'),
        import('../dist/domains/cats/services/stores/ports/MessageStore.js'),
        import('../dist/domains/cats/services/stores/ports/TaskStore.js'),
        import('../dist/routes/callback-thread-progress-routes.js'),
        import('../dist/domains/thread-progress/ThreadProgressReceiptStore.js'),
      ]);
    const registry = new InvocationRegistry();
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const taskStore = new TaskStore();
    const receiptStore = new storeModule.ThreadProgressReceiptStore();
    const app = Fastify();
    routeModule.registerCallbackThreadProgressRoutes(app, {
      registry,
      receiptStore,
      threadStore,
      messageStore,
      taskStore,
    });
    return { app, registry, threadStore, messageStore, taskStore, receiptStore };
  }

  test('derives owner, thread, actor, time and source identity from callback truth', async () => {
    const fx = await createFixture();
    const thread = fx.threadStore.create('user-1', 'Long-running work');
    const { invocationId, callbackToken } = await fx.registry.create('user-1', 'opus', thread.id);

    const payload = {
      kind: 'decision',
      impactAxes: ['goal_or_scope', 'next_action'],
      headline: 'Phase A 只交付单会话进度',
      nextStep: '完成隔离验收',
      provenance: [{ kind: 'invocation', invocationId }],
    };
    const first = await fx.app.inject({
      method: 'POST',
      url: '/api/callbacks/record-thread-progress',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload,
    });
    const replay = await fx.app.inject({
      method: 'POST',
      url: '/api/callbacks/record-thread-progress',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        ...payload,
        kind: 'milestone',
        headline: '同一 turn 的第二类回执也不能新增',
      },
    });

    assert.equal(first.statusCode, 200);
    assert.equal(replay.statusCode, 200);
    assert.equal(first.json().inserted, true);
    assert.equal(replay.json().inserted, false);
    const [receipt] = await fx.receiptStore.listByThread('user-1', thread.id);
    assert.equal(receipt.ownerUserId, 'user-1');
    assert.equal(receipt.threadId, thread.id);
    assert.equal(receipt.actor.catId, 'opus');
    assert.equal(receipt.provenance[0].invocationId, invocationId);
    assert.equal(typeof receipt.occurredAt, 'number');
    assert.equal(typeof receipt.sourceKey, 'string');
    await fx.app.close();
  });

  test('rejects cross-thread provenance and forged server-owned fields', async () => {
    const fx = await createFixture();
    const own = fx.threadStore.create('user-1', 'Own');
    const other = fx.threadStore.create('user-2', 'Other');
    const foreignMessage = await fx.messageStore.append({
      threadId: other.id,
      userId: 'user-2',
      catId: null,
      content: 'foreign',
      timestamp: Date.now(),
    });
    const { invocationId, callbackToken } = await fx.registry.create('user-1', 'opus', own.id);

    const forged = await fx.app.inject({
      method: 'POST',
      url: '/api/callbacks/record-thread-progress',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        kind: 'milestone',
        impactAxes: ['verified_outcome'],
        headline: 'forged',
        ownerUserId: 'user-2',
        provenance: [{ kind: 'message', messageId: foreignMessage.id }],
      },
    });

    assert.equal(forged.statusCode, 400);
    assert.deepEqual(await fx.receiptStore.listByThread('user-1', own.id), []);
    await fx.app.close();
  });
});
