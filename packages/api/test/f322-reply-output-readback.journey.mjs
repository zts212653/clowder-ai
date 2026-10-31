import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  finalizeCodexStream,
  transformCodexEvent,
} from '../dist/domains/cats/services/agents/providers/codex-event-transform.js';
import { routeParallel } from '../dist/domains/cats/services/agents/routing/route-parallel.js';
import { routeSerial } from '../dist/domains/cats/services/agents/routing/route-serial.js';
import { RedisDraftStore } from '../dist/domains/cats/services/stores/redis/RedisDraftStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { DraftKeys } from '../dist/domains/cats/services/stores/redis-keys/draft-keys.js';
import { messagesRoutes } from '../dist/routes/messages.js';
import { subexecutionReadbackFrames } from './helpers/f322-subexecution-readback.mjs';

const CONTENT = '检查 **日志** 🐾。\n\n保留 **答案段** 🐾。\n\n第二段完整回答。\n\n[Sol/gpt-6.1-sol🐾]';
const traces = [];
const childEvents = subexecutionReadbackFrames().map((frame) => {
  const messages = observedMessages(frame);
  assert.equal(messages.length, 1, 'each controlled native frame must pass the unchanged production mapper');
  assert.equal(messages[0].semanticEvent?.kind, 'subexecution');
  return messages[0].semanticEvent;
});

function observedMessages(event, state) {
  const result = transformCodexEvent(event, 'codex', state);
  return Array.isArray(result) ? result : result ? [result] : [];
}

async function removeOwnedKeys(redis, prefix) {
  let cursor = '0';
  do {
    const page = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
    cursor = page[0];
    const keys = page[1];
    assert.ok(keys.every((key) => key.startsWith(prefix)));
    // ioredis SCAN returns physical keys; DEL adds the client's private prefix.
    if (keys.length) await redis.del(...keys.map((key) => key.slice(prefix.length)));
  } while (cursor !== '0');
  assert.deepEqual((await redis.scan('0', 'MATCH', `${prefix}*`, 'COUNT', 100))[1], []);
}

function* observedChildren(events, state, metadata) {
  const ids = new Set(events.map((event) => event.id));
  for (const frame of subexecutionReadbackFrames()) {
    if (!ids.has(frame.event_id)) continue;
    for (const signal of observedMessages(frame, state)) {
      metadata.subexecutionEvents = [...metadata.subexecutionEvents, signal.semanticEvent];
      yield { ...signal, metadata: { ...metadata } };
    }
  }
}

function observedService(events) {
  return {
    async *invoke() {
      const state = { hadPriorTextTurn: false, canonicalSignature: '[Sol/gpt-6.1-sol🐾]' };
      const metadata = { provider: 'openai', model: 'gpt-6.1-sol', subexecutionEvents: [] };
      for (const [id, phase, text] of [
        ['process', 'commentary', '检查 **日志** 🐾。'],
        ['answer', 'final_answer', '保留 **答案段** 🐾。\n\n第二段完整回答。'],
      ]) {
        for (const message of observedMessages(
          {
            type: 'item.completed',
            thread_id: 'native-readback',
            turn_id: 'native-turn',
            item: { type: 'agent_message', id, phase, text },
          },
          state,
        ))
          yield { ...message, metadata: { ...metadata } };
        if (id === 'process') {
          yield { type: 'tool_use', catId: 'codex', toolName: 'read', toolUseId: 'readback-pair', timestamp: 2 };
          yield { type: 'tool_result', catId: 'codex', toolUseId: 'readback-pair', content: 'ok', timestamp: 3 };
          yield* observedChildren(events, state, metadata);
        }
      }
      transformCodexEvent({ type: 'turn.completed', usage: {} }, 'codex', state);
      const signature = finalizeCodexStream(state, 'codex');
      assert.ok(signature?.hostOutput, 'real finalizer must stamp the host-owned suffix');
      yield signature;
      yield { type: 'done', catId: 'codex', timestamp: 6 };
    },
  };
}

async function history(app, userId, threadId) {
  const response = await app.inject({
    method: 'GET',
    url: `/api/messages?threadId=${encodeURIComponent(threadId)}`,
    headers: { 'x-cat-cafe-user': userId },
  });
  assert.equal(response.statusCode, 200);
  return response.json().messages;
}

async function fixture(t, name) {
  const namespace = `f322:readback:${process.pid}:${randomUUID()}:`;
  const pending = [];
  // Explicit destination: this journey cannot inherit the runtime Redis URL.
  const redis = createRedisClient({ url: 'redis://127.0.0.1:6398', keyPrefix: namespace });
  const app = Fastify();
  t.after(async () => {
    await Promise.allSettled(pending);
    await app.close();
    try {
      await removeOwnedKeys(redis, namespace);
    } finally {
      await redis.quit();
    }
  });
  assert.equal(redis.options.port, 6398);
  assert.equal(await redis.ping(), 'PONG');
  const messageStore = new RedisMessageStore(redis, { ttlSeconds: 0 });
  const drafts = new RedisDraftStore(redis, { ttlSeconds: 0 });
  const userId = `owner-${name}`;
  const threadId = `f322-readback-${name}`;
  const childId = `child-${randomUUID()}`;
  const registry = new InvocationRegistry();
  await app.register(messagesRoutes, {
    registry,
    messageStore,
    draftStore: drafts,
    socketManager: { broadcastAgentMessage: () => {} },
  });
  await app.ready();
  const snapshots = [];
  const track = (work) => {
    pending.push(work);
    return work;
  };
  const draftStore = {
    upsert(value) {
      return track(
        (async () => {
          await drafts.upsert(value);
          const persisted = (await drafts.getByThread(userId, threadId)).find(
            (draft) => draft.invocationId === childId,
          );
          assert.ok(persisted, 'Draft snapshot must be read back from real Redis');
          assert.equal(persisted.content, value.content);
          assert.deepEqual(persisted.extra?.outputLayout, value.extra?.outputLayout);
          assert.deepEqual(persisted.metadata?.subexecutionEvents, value.metadata?.subexecutionEvents);
          const api = (await history(app, userId, threadId)).find((message) => message.id === `draft-${childId}`);
          assert.ok(api, 'active Draft must survive the real history route');
          assert.equal(api.content, persisted.content);
          assert.deepEqual(api.extra?.outputLayout, persisted.extra?.outputLayout);
          assert.deepEqual(api.metadata?.subexecutionEvents, persisted.metadata?.subexecutionEvents);
          const freshDraftReader = new RedisDraftStore(redis, { ttlSeconds: 0 });
          const restored = (await freshDraftReader.getByThread(userId, threadId)).find(
            (draft) => draft.invocationId === childId,
          );
          assert.deepEqual(restored?.metadata?.subexecutionEvents, value.metadata?.subexecutionEvents);
          assert.deepEqual(await history(app, 'foreign-owner', threadId), []);
          snapshots.push({ persisted, api });
        })(),
      );
    },
    delete: (...args) => track(drafts.delete(...args)),
    touch: (...args) => track(drafts.touch(...args)),
  };
  const events =
    name === 'parallel' ? childEvents.filter((event) => event.subexecutionId === 'child-schema') : childEvents;
  const deps = {
    services: { codex: observedService(events) },
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: childId, callbackToken: 'synthetic-token' }),
        verify: registry.verify.bind(registry),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/f322-readback',
      },
      threadStore: {
        get: async () => null,
        getParticipantsWithActivity: async () => [],
        consumeMentionRoutingFeedback: async () => null,
        updateParticipantActivity: async () => {},
      },
      apiUrl: 'http://127.0.0.1:3102',
    },
    messageStore,
    draftStore,
  };
  return {
    redis,
    childEvents: events,
    messageStore,
    drafts,
    app,
    userId,
    threadId,
    childId,
    snapshots,
    deps,
    settle: () => Promise.all(pending),
  };
}

for (const [name, route] of [
  ['serial', routeSerial],
  ['parallel', routeParallel],
]) {
  test(`${name}: real producer → live → Redis Draft/formal → fresh GET history preserves content and ownership`, async (t) => {
    const f = await fixture(t, name);
    const live = [];
    for await (const event of route(f.deps, ['codex'], 'synthetic readback', f.userId, f.threadId)) {
      live.push(event);
      // Draft persistence is intentionally asynchronous. Observe each real
      // checkpoint before advancing the producer, rather than inspecting a fake write.
      await f.settle();
    }
    await f.settle();
    const records = await f.messageStore.getByThread(f.threadId, 20, f.userId);
    const formal = records.find((record) => record.origin === 'stream' && record.catId === 'codex');
    assert.ok(formal);
    assert.equal(formal.content, CONTENT);
    assert.deepEqual(formal.metadata?.subexecutionEvents, f.childEvents);
    assert.ok(!formal.content.includes('子代理'), 'child prose never enters the mother content');
    const layout = formal.extra?.outputLayout;
    assert.equal(layout?.status, 'available');
    assert.equal(layout.owner.turnInvocationId, f.childId);
    assert.equal(layout.runs.length, 2);
    assert.deepEqual(
      layout.runs.map((run) => run.channel),
      ['commentary', 'final'],
    );
    assert.equal(formal.content.slice(layout.hostTail.start), '\n\n[Sol/gpt-6.1-sol🐾]');
    assert.equal(layout.runs.at(-1).end, layout.hostTail.start);
    const lastText = live.filter((event) => event.type === 'text').at(-1);
    assert.equal(lastText?.textMode, 'replace');
    assert.equal(lastText.content, formal.content);
    assert.deepEqual(lastText.extra?.outputLayout, layout);
    const lastDraft = f.snapshots.at(-1);
    assert.ok(lastDraft);
    assert.equal(lastDraft.persisted.content, formal.content);
    assert.deepEqual(lastDraft.persisted.extra?.outputLayout, layout);
    assert.deepEqual(lastDraft.persisted.metadata?.subexecutionEvents, f.childEvents);
    assert.deepEqual(lastDraft.api.metadata?.subexecutionEvents, f.childEvents);
    const childSnapshots = f.snapshots.filter((snapshot) => snapshot.persisted.metadata?.subexecutionEvents?.length);
    assert.equal(
      childSnapshots[0]?.persisted.metadata.subexecutionEvents.length,
      1,
      'a real child signal creates an active recoverable checkpoint before the next root text',
    );
    const done = live.filter((event) => event.type === 'done').at(-1);
    assert.deepEqual(done.extra?.outputLayout, layout);
    assert.equal((await f.drafts.getByThread(f.userId, f.threadId)).length, 0);
    const api = (await history(f.app, f.userId, f.threadId)).find((message) => message.id === formal.id);
    assert.ok(api);
    assert.equal(api.content, formal.content);
    assert.deepEqual(api.extra?.outputLayout, layout);
    assert.deepEqual(api.metadata?.subexecutionEvents, f.childEvents);
    assert.deepEqual(
      api.toolEvents.map((tool) => tool.id),
      formal.toolEvents.map((tool) => tool.id),
    );
    assert.notEqual(api.toolEvents[0].id, api.toolEvents[1].id);
    assert.deepEqual(await history(f.app, 'foreign-owner', f.threadId), []);
    const restarted = new RedisMessageStore(f.redis, { ttlSeconds: 0 });
    assert.deepEqual((await restarted.getById(formal.id)).extra?.outputLayout, layout);
    assert.deepEqual((await restarted.getById(formal.id)).metadata?.subexecutionEvents, f.childEvents);
    traces.push({
      route: name,
      userId: f.userId,
      threadId: f.threadId,
      childId: f.childId,
      live,
      draft: lastDraft,
      formal,
      api,
    });
  });
}

test('Draft metadata uses the formal whitelist, survives a new reader and clears without changing content or owner', async (t) => {
  const f = await fixture(t, 'metadata');
  const base = {
    userId: f.userId,
    threadId: f.threadId,
    invocationId: f.childId,
    catId: 'codex',
    content: 'Original body',
    updatedAt: 1000,
  };
  const metadata = { provider: 'openai', model: 'gpt-6.1-sol', subexecutionEvents: childEvents };
  await f.drafts.upsert({ ...base, metadata });
  const key = DraftKeys.detail(f.userId, f.threadId, f.childId);
  assert.equal(await f.redis.ttl(key), -1, 'the explicitly persistent fixture retains TTL=0 semantics');
  assert.deepEqual(
    (await new RedisDraftStore(f.redis, { ttlSeconds: 0 }).getByThread(f.userId, f.threadId))[0].metadata,
    metadata,
  );
  assert.deepEqual(await f.drafts.getByThread('foreign-owner', f.threadId), []);
  for (const raw of [
    'broken-json',
    JSON.stringify({ ...metadata, subexecutionEvents: [{ ...childEvents[0], parentTurnId: '' }] }),
    JSON.stringify({ ...metadata, subexecutionEvents: Array.from({ length: 257 }, () => childEvents[0]) }),
  ]) {
    await f.redis.hset(key, 'metadata', raw);
    const restored = (await f.drafts.getByThread(f.userId, f.threadId))[0];
    assert.equal(restored.metadata?.subexecutionEvents, undefined);
    assert.equal(restored.content, base.content);
    assert.equal(restored.userId, base.userId);
  }
  await f.drafts.upsert({ ...base, metadata });
  await f.drafts.upsert({ ...base, updatedAt: 2000 });
  assert.equal(await f.redis.hget(key, 'metadata'), null, 'an omitted latest carrier does not inherit stale metadata');
  const restored = (await f.drafts.getByThread(f.userId, f.threadId))[0];
  assert.equal(restored.createdAt, 1000);
  assert.equal(restored.content, base.content);
  assert.equal(restored.metadata, undefined);
});

test('export only bounded synthetic station observations after both real-store routes passed', async () => {
  assert.equal(traces.length, 2);
  if (process.env.F322_READBACK_ARTIFACT) {
    await writeFile(
      process.env.F322_READBACK_ARTIFACT,
      `${JSON.stringify({ v: 1, redisPort: 6398, traces }, null, 2)}\n`,
    );
  }
});
