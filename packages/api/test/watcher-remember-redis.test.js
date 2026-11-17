import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { RedisAuthInvocationBackend } from '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.js';
import { WATCHER_TOOL_ROUTES } from '../dist/domains/cats/services/agents/invocation/WatcherToolTicket.js';
import { clearAuthTestNamespace, createAuthTestNamespace } from './helpers/redis-auth-namespace.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';
import { fixture } from './helpers/watcher-remember-fixture.js';

const namespace = createAuthTestNamespace('watcher-remember');
let redis;
before(async () => {
  assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F335 watcher remember');
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
const registry = () => new InvocationRegistry({ backend: new RedisAuthInvocationBackend(redis) });

test(
  'Redis reconstructs one complete four-item receipt without replaying any original domain write',
  options,
  async (t) => {
    const first = await fixture(t, { registry: registry() });
    assert.equal(await first.admit('batch'), 'accepted');
    const response = await first.app.inject(first.request('batch'));
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      response.json().results.map((row) => row.statusCode),
      [200, 200, 200, 200],
    );
    assert.equal(first.calls.length, 4);
    await first.app.close();
    const restored = await fixture(t, { registry: registry(), auth: first.auth });
    const replay = await restored.app.inject(restored.request('batch'));
    assert.deepEqual(replay.json(), response.json());
    assert.equal(restored.calls.length, 0);
    assert.equal(await restored.registry.watcherToolCallCount(first.auth.invocationId), 1);
    assert.equal(await restored.admit('batch'), 'replayed');
  },
);

test('Redis reconstruction preserves an unknown batch result after the effects/receipt gap', options, async (t) => {
  const first = await fixture(t, { registry: registry() });
  await first.admit('unknown');
  first.registry.completeWatcherToolCallback = async () => {};
  const response = await first.app.inject(first.request('unknown'));
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(first.calls.length, 4);
  await first.app.close();
  const restored = await fixture(t, { registry: registry(), auth: first.auth });
  const result = await restored.app.inject(restored.request('unknown'));
  assert.equal(result.statusCode, 409, result.body);
  assert.equal(result.json().error, 'watcher_tool_result_pending');
  assert.equal(restored.calls.length, 0);
  assert.equal(await restored.registry.watcherToolCallCount(first.auth.invocationId), 1);
});

test('Redis unified read tickets bind one original branch and reconstruct its exact receipt', options, async () => {
  const first = registry();
  const auth = await first.create('reader-owner', 'codex61-sol', 'reader-line', undefined, undefined, {
    mode: 'watcher',
    maxToolCalls: 6,
    allowedToolNames: ['cat_cafe_read_memory'],
    allowedCallbackRoutes: WATCHER_TOOL_ROUTES.cat_cafe_read_memory,
  });
  for (const [index, route] of WATCHER_TOOL_ROUTES.cat_cafe_read_memory.entries()) {
    const callId = `source-${index}`;
    assert.equal(await first.consumeWatcherToolCall(auth.invocationId, callId, 'cat_cafe_read_memory'), 'accepted');
    assert.equal(
      (await first.claimWatcherToolCallback(auth.invocationId, callId, 'POST /api/callbacks/memory-cues/drill', 'hash'))
        .kind,
      'denied',
    );
    assert.equal((await first.claimWatcherToolCallback(auth.invocationId, callId, route, 'hash')).kind, 'claimed');
    const different = WATCHER_TOOL_ROUTES.cat_cafe_read_memory.find((candidate) => candidate !== route);
    assert.equal((await first.claimWatcherToolCallback(auth.invocationId, callId, different, 'hash')).kind, 'denied');
    const response = { statusCode: 200, body: `original ${index}` };
    await first.completeWatcherToolCallback(auth.invocationId, callId, response);
    assert.deepEqual(await registry().claimWatcherToolCallback(auth.invocationId, callId, route, 'hash'), {
      kind: 'completed',
      response,
    });
    assert.equal(
      (await registry().claimWatcherToolCallback(auth.invocationId, callId, route, 'changed')).kind,
      'denied',
    );
  }
});
