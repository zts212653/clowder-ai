import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { parseWatcherSessionState } from '@cat-cafe/shared';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { RedisAuthInvocationBackend } from '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.js';
import { watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { RedisSessionChainStore } from '../dist/domains/cats/services/stores/redis/RedisSessionChainStore.js';
import { RedisThreadStore } from '../dist/domains/cats/services/stores/redis/RedisThreadStore.js';
import { RedisTurnExecutionStore } from '../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';
import { RedisConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';
import { readWatcherOutputFence } from '../dist/domains/concierge/watcher/watcher-output-fence.js';
import { createSuggestionIntegration } from '../dist/domains/suggestions/composition.js';
import { clearAuthTestNamespace, createAuthTestNamespace } from './helpers/redis-auth-namespace.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const namespace = createAuthTestNamespace('watcher');
let redis;
before(async () => {
  assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F335 watcher');
  redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: namespace });
  await redis.ping();
});
after(async () => {
  if (redis) {
    await clearAuthTestNamespace(redis, namespace);
    await redis.quit();
  }
});
const options = { skip: redisIsolationSkipReason(process.env.REDIS_URL) };

test(
  'selected scope and per-thread choices persist, and scope changes fence already prepared output',
  options,
  async () => {
    const configs = new RedisConciergeConfigStore(redis),
      threads = new RedisThreadStore(redis),
      messages = new RedisMessageStore(redis);
    const userId = 'selected-scope-owner',
      thread = await threads.create(userId);
    const owners = { configs, threads, labels: { list: async () => [] } };
    assert.equal((await configs.readWatcherConfig(userId)).scope, 'selected');
    assert.equal(await readWatcherOutputFence(owners, userId, thread.id, 'codex61-sol'), null);
    await configs.updateWatcherConfig(userId, 0, { scope: 'all', memberCatId: 'codex' });
    const old = await readWatcherOutputFence(owners, userId, thread.id, 'codex');
    assert.ok(old);
    await configs.updateWatcherConfig(userId, 1, { scope: 'selected' });
    const append = (fence) =>
      messages.append({
        userId,
        threadId: thread.id,
        from: { kind: 'agent', catId: 'codex' },
        content: 'scoped output',
        timestamp: Date.now(),
        mentions: [],
        watcherOutputFence: fence,
      });
    await assert.rejects(append(old), /watcher_output_control_changed/);
    assert.equal(await readWatcherOutputFence(owners, userId, thread.id, 'codex'), null);
    await threads.updateWatcherControl(thread.id, 0, { enabled: true });
    assert.equal((await new RedisConciergeConfigStore(redis).readWatcherConfig(userId)).scope, 'selected');
    assert.equal((await new RedisThreadStore(redis).get(thread.id)).watcher.enabled, true);
    const selected = await readWatcherOutputFence(owners, userId, thread.id, 'codex');
    assert.ok(selected);
    assert.ok(await append(selected));
    await configs.updateWatcherConfig(userId, 2, { enabled: false });
    assert.equal(await readWatcherOutputFence(owners, userId, thread.id, 'codex'), null);
    await assert.rejects(append(selected), /watcher_output_control_changed/);
  },
);

test('pause wins the actual Redis output commit window for nudges and prepared offers', options, async () => {
  const threads = new RedisThreadStore(redis);
  const messages = new RedisMessageStore(redis);
  const thread = await threads.create('commit-owner');
  const fence = { userId: 'commit-owner', threadId: thread.id, configRevision: 0, controlRevision: 0, labels: '[]' };
  const original = await messages.append({
    userId: 'commit-owner',
    threadId: thread.id,
    from: { kind: 'user', userId: 'commit-owner' },
    content: 'source',
    timestamp: Date.now(),
    mentions: [],
  });
  // Captured while speaking was allowed; pause commits during the owner's final I/O window.
  await threads.updateWatcherControl(thread.id, 0, { pausedUntil: Date.now() + 7200000 });
  await assert.rejects(
    messages.append({
      userId: 'commit-owner',
      threadId: thread.id,
      from: { kind: 'agent', catId: 'codex' },
      content: 'must not publish',
      timestamp: Date.now(),
      mentions: [],
      watcherOutputFence: fence,
    }),
    /watcher_output_control_changed/,
  );
  const integration = createSuggestionIntegration({
    redis,
    messageStore: messages,
    watcherOutputFence: async () => fence,
  });
  integration.registry.register({
    kind: 'fenced_offer',
    kindLabel: 'one',
    prepare: async () => ({ ok: true, value: {} }),
    apply: async () => ({ ok: false, error: 'unused' }),
    undo: async () => ({ ok: false, error: 'unused' }),
  });
  const offer = await integration.service.offer(
    { userId: 'commit-owner', threadId: thread.id, catId: 'codex', byline: 'watcher' },
    { messageId: original.id, label: 'must not publish', action: { kind: 'fenced_offer', params: {} } },
  );
  assert.equal(offer.ok, false);
  assert.deepEqual(await integration.service.listThread('commit-owner', thread.id), []);
});

test('a preference CAS racing initial activation retains the complete published-read boundary', options, async () => {
  let boundary;
  const interleaved = new Proxy(redis, {
    get(target, property) {
      if (property === 'get')
        return async (...args) => {
          const before = await target.get(...args);
          const initializer = new RedisConciergeConfigStore(redis);
          await initializer.initializeWatcherCursor('activation-race', 91);
          boundary = await initializer.readWatcherConfig('activation-race');
          return before;
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const result = await new RedisConciergeConfigStore(interleaved).updateWatcherConfig('activation-race', 0, {
    doNotDisturbLabelIds: ['private'],
  });
  assert.equal(result.startedAfterSequence, 91);
  assert.equal(result.activatedAt, boundary.activatedAt);
  assert.equal(typeof result.activatedAt, 'number');
});

test(
  'Redis resumes a watcher independently of the work home chain and allows exactly one checkpoint CAS winner',
  options,
  async () => {
    const store = new RedisSessionChainStore(redis);
    const work = await store.create({ userId: 'u', catId: 'codex', threadId: 't', cliSessionId: 'work-native' });
    const watch = await store.getOrCreateActive({
      userId: 'u',
      catId: 'codex',
      threadId: 't',
      sessionPurpose: 'watcher',
      chainKey: watcherSessionChainKey('u', 'codex', 't'),
    });
    const state = parseWatcherSessionState(undefined);
    const results = await Promise.all(
      ['A', 'B'].map((notes) =>
        store.compareAndSetWatcherState(watch.id, 0, {
          ...state,
          revision: 1,
          notes,
          activationCut: '2:3',
          rawSince: 100,
        }),
      ),
    );
    assert.equal(results.filter(Boolean).length, 1);
    const restored = new RedisSessionChainStore(redis);
    assert.equal((await restored.getActive('codex', 't', 'u')).id, work.id);
    assert.equal((await restored.getByChainKey(watch.chainKey)).watcherState.revision, 1);
    assert.equal((await restored.getByChainKey(watch.chainKey)).watcherState.activationCut, '2:3');
    assert.equal((await restored.getByChainKey(watch.chainKey)).watcherState.rawSince, 100);
    assert.equal((await restored.get(work.id)).status, 'active');
    assert.equal(work.seq, 0);
    assert.equal(watch.seq, 0);
    const nextHome = await restored.create({
      userId: 'u',
      catId: 'codex',
      threadId: 't',
      cliSessionId: 'next-work-native',
    });
    assert.equal(nextHome.seq, 1);
  },
);

test(
  'Redis role callback credentials survive restart independently, and concurrent calls share one six-call budget',
  options,
  async () => {
    const registry = new InvocationRegistry({ backend: new RedisAuthInvocationBackend(redis) });
    const work = await registry.create('u', 'codex', 'budget-t');
    const watch = await registry.create('u', 'codex', 'budget-t', undefined, undefined, {
      mode: 'watcher',
      maxToolCalls: 6,
      allowedToolNames: ['cat_cafe_get_message'],
      allowedCallbackRoutes: [],
    });
    const calls = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        registry.consumeWatcherToolCall(watch.invocationId, `call-${i}`, 'cat_cafe_watcher_nudge'),
      ),
    );
    assert.equal(calls.filter((value) => value === 'accepted').length, 6);
    const restored = new InvocationRegistry({ backend: new RedisAuthInvocationBackend(redis) });
    assert.equal((await restored.verifyLatest(work.invocationId, work.callbackToken)).ok, true);
    assert.equal((await restored.verifyLatest(watch.invocationId, watch.callbackToken)).ok, true);
    assert.equal(
      await restored.consumeWatcherToolCall(watch.invocationId, 'call-0', 'cat_cafe_watcher_nudge'),
      'replayed',
    );
    assert.equal(
      await restored.consumeWatcherToolCall(watch.invocationId, 'call-after-restart', 'cat_cafe_watcher_nudge'),
      'exhausted',
    );
    assert.equal(
      (
        await restored.claimWatcherToolCallback(
          watch.invocationId,
          'call-0',
          'GET /api/callbacks/get-message',
          'request',
        )
      ).kind,
      'denied',
    );
    assert.equal(
      (
        await restored.claimWatcherToolCallback(
          watch.invocationId,
          'call-0',
          'POST /api/callbacks/watcher-nudge',
          'request',
        )
      ).kind,
      'claimed',
    );
    await restored.completeWatcherToolCallback(watch.invocationId, 'call-0', {
      statusCode: 200,
      body: '{"delivered":true}',
    });
    const restartedAgain = new InvocationRegistry({ backend: new RedisAuthInvocationBackend(redis) });
    assert.deepEqual(
      await restartedAgain.claimWatcherToolCallback(
        watch.invocationId,
        'call-0',
        'POST /api/callbacks/watcher-nudge',
        'request',
      ),
      { kind: 'completed', response: { statusCode: 200, body: '{"delivered":true}' } },
    );
  },
);

test('Redis daily pages retain usage and exact settlement order without expiring user facts', options, async () => {
  const turns = new RedisTurnExecutionStore(redis);
  const at = Date.UTC(2026, 10, 2, 12);
  for (let i = 0; i < 3; i++) {
    const id = `daily-${i}`;
    await turns.createRunning({
      invocationId: id,
      parentInvocationId: id,
      userId: 'daily-u',
      threadId: `line-${i % 2}`,
      catId: 'codex',
      executionKind: 'watcher',
      outputFence: 'open',
      startedAt: at,
    });
    await turns.recordWatcherUsage(id, { reportedAt: at, inputTokens: 100, cacheReadTokens: 20 });
    await turns.transitionTerminal(id, { status: 'succeeded', endedAt: at + i + 1 });
    await turns.markResponseSettled(id, { kind: 'no_response', reason: 'tool_only', settledAt: at + i + 2 });
  }
  const query = { userId: 'daily-u', watcherDay: Math.floor(at / 86400000), limit: 2 };
  const first = await turns.listSettled(query);
  assert.equal(first.records.length, 2);
  assert.equal(first.hasMore, true);
  const second = await new RedisTurnExecutionStore(redis).listSettled({ ...query, afterSequence: first.nextCursor });
  assert.deepEqual(
    second.records.map((record) => record.invocationId),
    ['daily-2'],
  );
  assert.equal(second.records[0].watcherUsage.cacheReadTokens, 20);
  assert.equal((await turns.listSettled({ ...query, watcherDay: query.watcherDay + 1 })).records.length, 0);
  const configs = new RedisConciergeConfigStore(redis);
  await configs.initializeWatcherCursor('daily-u', 7);
  await configs.updateWatcherConfig('daily-u', 0, { enabled: false });
  await configs.updateWatcherConfig('daily-u', 1, { enabled: true }, 20);
  assert.equal((await configs.readWatcherConfig('daily-u')).startedAfterSequence, 20);
  assert.equal((await new RedisConciergeConfigStore(redis).readWatcherConfig('daily-u')).activationRevision, 2);
  const threads = new RedisThreadStore(redis);
  const thread = await threads.create('daily-u');
  const opened = await threads.updateWatcherControl(
    thread.id,
    0,
    { enabled: true },
    { startedAfterSequence: 20, changedAt: 100 },
  );
  assert.equal(opened.activationRevision, 1);
  assert.equal((await new RedisThreadStore(redis).get(thread.id)).watcher.activatedAt, 100);
  for (const key of await redis.keys(`${namespace}*`))
    assert.equal(await redis.ttl(key.slice(namespace.length)), -1, key);
});
