import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import {
  commitLifecycleResponseFromAppendInput,
  lifecycleResponseTerminalPatchFromAppendInput,
  MessageStore,
} from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { messageActionsRoutes } from '../dist/routes/message-actions.js';
import { harness, waitFor } from './helpers/issue1371-queue-harness.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const question = {
  id: 'async-question',
  kind: 'interactive',
  v: 1,
  interactiveType: 'select',
  options: [{ id: 'custom', label: 'Other answer', customInput: true }],
};

test('#1951 a streamed question is durable before broadcast and answerable before completion', async (t) => {
  const h = await harness();
  const detachedStore = new Proxy(h.store, {
    get(target, key) {
      if (key === 'getById') return (id) => structuredClone(target.getById(id));
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  h.processor.deps.messageStore = detachedStore;
  const app = Fastify();
  await app.register(messageActionsRoutes, { messageStore: detachedStore, socketManager: {} });
  const finish = Promise.withResolvers();
  let execution;
  let responseId;
  let stateAtBroadcast;
  const execute = h.processor.executeEntry.bind(h.processor);
  h.processor.executeEntry = (...args) => (execution = execute(...args));
  t.after(async () => {
    finish.resolve();
    await execution;
    await app.close();
    await h.app.close();
  });
  h.processor.deps.socketManager.broadcastAgentMessage = (event) => {
    if (responseId || event.type !== 'system_info' || !event.content) return;
    const payload = JSON.parse(event.content);
    if (payload.type !== 'rich_block' || payload.block?.id !== question.id) return;
    responseId = event.messageId;
    stateAtBroadcast = structuredClone(h.store.getById(responseId).extra?.rich?.blocks);
  };
  h.routeExecution.mock.mockImplementation(
    async function* (userId, _content, threadId, _messageId, targets, _intent, options) {
      for (const catId of targets) {
        const childId = `turn-${catId}`;
        const admitted = await options.onLifecycleInvocationStarted({
          threadId,
          userId,
          catId,
          invocationId: childId,
          parentInvocationId: options.parentInvocationId,
          startedAt: Date.now(),
        });
        yield {
          type: 'system_info',
          catId,
          messageId: admitted.responseMessageId,
          content: JSON.stringify({ type: 'rich_block', block: question }),
          timestamp: Date.now(),
        };
        await finish.promise;
        await commitLifecycleResponseFromAppendInput(
          detachedStore,
          admitted.responseMessageId,
          childId,
          { status: 'completed', completedAt: Date.now() },
          {
            from: { kind: 'agent', catId },
            userId,
            threadId,
            content: 'Finished',
            mentions: [],
            timestamp: Date.now(),
            extra: { rich: { v: 1, blocks: [structuredClone(question)] } },
          },
        );
        yield { type: 'done', catId, messageId: admitted.responseMessageId, timestamp: Date.now() };
      }
    },
  );
  h.releaseCreate();
  await h.processor.requestDrain('thread-1');
  await waitFor(() => Boolean(responseId));
  const saved = await app.inject({
    method: 'PATCH',
    url: `/api/messages/${responseId}/block-state`,
    payload: { userId: 'user-1', blockId: question.id, disabled: true, selectedIds: ['custom'] },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(stateAtBroadcast[0].id, question.id);
  assert.equal(h.store.getById(responseId).lifecycle.status, 'processing');
  finish.resolve();
  await execution;
  const completed = h.store.getById(responseId);
  assert.equal(completed.lifecycle.status, 'completed');
  assert.equal(completed.extra.rich.blocks[0].disabled, true);
  assert.deepEqual(completed.extra.rich.blocks[0].selectedIds, ['custom']);
});

test('#1951 terminal output preserves the answer saved while the response was processing', async () => {
  const store = new MessageStore();
  const input = {
    from: { kind: 'agent', catId: 'codex' },
    userId: 'owner',
    threadId: 'isolated-thread',
    content: '',
    mentions: [],
    timestamp: 100,
    extra: { rich: { v: 1, blocks: [structuredClone(question)] } },
  };
  const response = store.append({
    ...input,
    lifecycle: {
      kind: 'response',
      orderKey: '100:response',
      invocationId: 'turn',
      targetId: 'codex',
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'processing',
      startedAt: 100,
    },
  });
  store.updateExtra(response.id, {
    rich: { v: 1, blocks: [{ ...structuredClone(question), disabled: true, selectedIds: ['custom'] }] },
  });

  const output = { ...input, content: 'Finished', extra: { rich: { v: 1, blocks: [structuredClone(question)] } } };
  const patch = lifecycleResponseTerminalPatchFromAppendInput(
    store.getById(response.id),
    'turn',
    { status: 'completed', completedAt: 200 },
    output,
  );
  assert.equal(patch.extra.rich.blocks[0].disabled, true, 'Redis must receive the saved state in patch.extra');
  const completed = await commitLifecycleResponseFromAppendInput(
    store,
    response.id,
    'turn',
    { status: 'completed', completedAt: 200 },
    output,
  );

  assert.equal(completed.extra.rich.blocks[0].disabled, true);
  assert.deepEqual(completed.extra.rich.blocks[0].selectedIds, ['custom']);
});

test('#1951 a failed question write exposes a turn error instead of an unanswerable card', async (t) => {
  const h = await harness();
  t.after(() => h.app.close());
  const events = [];
  h.processor.deps.socketManager.broadcastAgentMessage = (event) => events.push(event);
  h.store.augmentStreamMetadata = async () => {
    throw new Error('Question storage unavailable');
  };
  h.routeExecution.mock.mockImplementation(
    async function* (userId, _content, threadId, _messageId, targets, _intent, options) {
      const catId = targets[0];
      const admitted = await options.onLifecycleInvocationStarted({
        threadId,
        userId,
        catId,
        invocationId: 'failed-question',
        parentInvocationId: options.parentInvocationId,
        startedAt: Date.now(),
      });
      yield {
        type: 'system_info',
        catId,
        messageId: admitted.responseMessageId,
        content: JSON.stringify({ type: 'rich_block', block: question }),
        timestamp: Date.now(),
      };
    },
  );
  h.releaseCreate();
  await h.processor.requestDrain('thread-1');
  await waitFor(() => events.some((event) => event.type === 'error'));
  assert.equal(
    events.some((event) => event.content?.includes('rich_block')),
    false,
  );
  assert.ok(
    events.some((event) => event.type === 'error' && event.isFinal && event.error === 'Question storage unavailable'),
  );
});

test(
  '#1951 Redis retains the saved answer after the terminal patch is committed',
  {
    skip: redisIsolationSkipReason(process.env.REDIS_URL),
  },
  async (t) => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, '#1951 interactive state');
    const [{ createRedisClient }, { RedisMessageStore }] = await Promise.all([
      import('@cat-cafe/shared/utils'),
      import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'),
    ]);
    const redis = createRedisClient({ url: process.env.REDIS_URL });
    t.after(() => redis.quit());
    const store = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const input = {
      from: { kind: 'agent', catId: 'codex' },
      userId: 'owner',
      threadId: 'issue1951-redis',
      content: '',
      mentions: [],
      timestamp: 100,
      extra: { rich: { v: 1, blocks: [structuredClone(question)] } },
    };
    const response = await store.append({
      ...input,
      lifecycle: {
        kind: 'response',
        orderKey: '100:response',
        invocationId: 'turn',
        targetId: 'codex',
        inputEntryIds: [],
        inputMessageIds: [],
        status: 'processing',
        startedAt: 100,
      },
    });
    await store.updateExtra(response.id, {
      rich: { v: 1, blocks: [{ ...question, disabled: true, selectedIds: ['custom'] }] },
    });
    await commitLifecycleResponseFromAppendInput(
      store,
      response.id,
      'turn',
      { status: 'completed', completedAt: 200 },
      { ...input, content: 'Finished' },
    );
    const reread = await store.getById(response.id);
    assert.equal(reread.lifecycle.status, 'completed');
    assert.equal(reread.extra.rich.blocks[0].disabled, true);
    assert.deepEqual(reread.extra.rich.blocks[0].selectedIds, ['custom']);
  },
);
