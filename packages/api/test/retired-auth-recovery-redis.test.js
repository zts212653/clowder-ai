import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import Fastify from 'fastify';
import { CallbackAuthTurnExecutionLifecycle } from '../dist/domains/cats/services/agents/invocation/CallbackAuthTurnExecutionLifecycle.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { RedisAuthInvocationBackend } from '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.js';
import { COMMIT_AUTH_TERMINAL_LUA } from '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationLua.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { clearAuthTestNamespace, createAuthTestNamespace } from './helpers/redis-auth-namespace.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const SKIP = redisIsolationSkipReason(REDIS_URL);
if (!SKIP) assertRedisIsolationOrThrow(REDIS_URL, 'retired-auth-recovery');
const legacyHash = (extra = {}) => ({
  invocationId: 'old',
  callbackToken: 'fixture-old-token',
  userId: 'owner',
  ownerAuthProvenance: 'strict',
  catId: 'codex61-sol',
  threadId: 'old-thread',
  createdAt: '1000',
  state: 'completed',
  endedAt: '2000',
  endReason: 'original_terminal',
  terminalRef: 'turn:original',
  ...extra,
});
const seed = (redis, raw) =>
  redis.hset(
    `auth:inv:${raw.invocationId}`,
    ...Object.entries(raw)
      .filter(([, v]) => v !== undefined)
      .flat(),
  );

async function fixture(t, clientWrapper = (client) => client) {
  const namespace = createAuthTestNamespace('retired-auth');
  const redis = createRedisClient({ url: REDIS_URL, keyPrefix: namespace });
  t.after(async () => {
    await clearAuthTestNamespace(redis, namespace);
    await redis.quit();
  });
  const backend = new RedisAuthInvocationBackend(clientWrapper(redis));
  const registry = new InvocationRegistry({ backend, startupRecoveryRequired: true });
  const app = Fastify();
  t.after(() => app.close());
  registerCallbackAuthHook(app, registry);
  app.get('/api/callbacks/recovery-probe', async () => ({ ok: true }));
  const probe = (c) =>
    app.inject({
      method: 'GET',
      url: '/api/callbacks/recovery-probe',
      headers: { 'x-invocation-id': c.invocationId, 'x-callback-token': c.callbackToken },
    });
  const start = Date.now() - 1;
  const fresh = await registry.create('owner', 'codex61-sol', 'fresh-thread');
  const recover = async () => {
    const lifecycle = new CallbackAuthTurnExecutionLifecycle(new InMemoryTurnExecutionStore(), registry);
    const result = await lifecycle.reconcileStartup({ processStartedAt: start });
    registry.markStartupRecoveryComplete();
    return result;
  };
  return { redis, backend, registry, fresh, recover, probe, namespace };
}

for (const mode of ['collective_participation', 'collective_work']) {
  test(`${mode} completed history survives real startup and fresh callbacks recover`, { skip: SKIP }, async (t) => {
    const f = await fixture(t);
    const raw = legacyHash({ toolExecutionPolicy: JSON.stringify({ mode }) });
    await seed(f.redis, raw);
    await f.redis.pexpire('auth:inv:old', 600_000);
    const beforeTtl = await f.redis.pttl('auth:inv:old');
    assert.equal((await f.probe(f.fresh)).statusCode, 503);
    await f.recover();
    assert.deepEqual(await f.redis.hgetall('auth:inv:old'), raw);
    const afterTtl = await f.redis.pttl('auth:inv:old');
    assert.ok(afterTtl > 0 && afterTtl <= beforeTtl, 'history retention was not rewritten');
    assert.equal((await f.probe(f.fresh)).statusCode, 200);
    assert.equal((await f.probe({ invocationId: 'old', callbackToken: raw.callbackToken })).statusCode, 401);
    const diagnostic = await f.backend.getRecord('old');
    assert.equal(diagnostic.state, 'completed');
    assert.equal(diagnostic.retiredAuthorization.toolExecutionPolicy, raw.toolExecutionPolicy);
    assert.deepEqual(await f.registry.verify('old', 'wrong-token'), { ok: false, reason: 'invalid_token' });
    // A fresh Redis client/registry has no process-local migration cache.
    const second = createRedisClient({ url: REDIS_URL, keyPrefix: f.namespace });
    try {
      const restarted = new InvocationRegistry({ backend: new RedisAuthInvocationBackend(second) });
      await restarted.migrateLegacyRecords();
      assert.equal((await restarted.verify(f.fresh.invocationId, f.fresh.callbackToken)).ok, true);
      assert.deepEqual(await restarted.verify('old', raw.callbackToken), { ok: false, reason: 'completed' });
      assert.deepEqual(await second.hgetall('auth:inv:old'), raw);
    } finally {
      await second.quit();
    }
  });
  for (const state of ['active', undefined]) {
    test(
      `${mode} ${state ?? 'unversioned'} active authority is revoked without dropping its history`,
      { skip: SKIP },
      async (t) => {
        const f = await fixture(t);
        const raw = legacyHash({ state, toolExecutionPolicy: JSON.stringify({ mode }) });
        await seed(f.redis, raw);
        await f.redis.set('auth:latest:old-thread:codex61-sol', 'old');
        assert.equal((await f.registry.verify('old', raw.callbackToken)).ok, false);
        await f.recover();
        const saved = await f.redis.hgetall('auth:inv:old');
        assert.equal(saved.state, 'revoked');
        assert.equal(saved.endReason, 'retired_authorization');
        assert.equal(saved.toolExecutionPolicy, raw.toolExecutionPolicy);
        assert.equal(saved.callbackToken, raw.callbackToken);
        assert.equal(saved.userId, raw.userId);
        assert.ok((await f.redis.pttl('auth:inv:old')) > 0);
        assert.equal(await f.backend.isLatest('old'), false);
        assert.deepEqual(await f.registry.verify('old', raw.callbackToken), { ok: false, reason: 'revoked' });
        assert.equal((await f.probe(f.fresh)).statusCode, 200);
        const before = await f.redis.hgetall('auth:inv:old');
        await f.registry.migrateLegacyRecords();
        assert.deepEqual(await f.redis.hgetall('auth:inv:old'), before, 'subsequent recovery is idempotent');
      },
    );
  }
}

for (const field of ['executionGrant', 'collectiveWorkBinding']) {
  test(`legacy ${field} without a policy cannot survive as ordinary owner authority`, { skip: SKIP }, async (t) => {
    const f = await fixture(t);
    const raw = legacyHash({ state: 'active', [field]: '{"historical":"opaque"}' });
    await seed(f.redis, raw);
    assert.equal((await f.registry.verify('old', raw.callbackToken)).ok, false);
    await f.recover();
    assert.deepEqual(await f.registry.verify('old', raw.callbackToken), { ok: false, reason: 'revoked' });
    assert.equal(await f.redis.hget('auth:inv:old', field), raw[field]);
    assert.equal((await f.probe(f.fresh)).statusCode, 200);
  });
}

for (const race of ['terminal-wins', 'gc-before-cas']) {
  test(`retired migration preserves the atomic lifecycle boundary: ${race}`, { skip: SKIP }, async (t) => {
    let injected = false;
    const f = await fixture(
      t,
      (redis) =>
        new Proxy(redis, {
          get(target, property) {
            if (property === 'eval')
              return async (...args) => {
                if (args[0] === COMMIT_AUTH_TERMINAL_LUA && !injected) {
                  injected = true;
                  if (race === 'terminal-wins')
                    await redis.hset(
                      'auth:inv:old',
                      'state',
                      'completed',
                      'endedAt',
                      '3000',
                      'endReason',
                      'provider-won',
                    );
                  else await redis.pexpire('auth:inv:old', 0);
                }
                return redis.eval(...args);
              };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
    );
    await seed(f.redis, legacyHash({ state: 'active', toolExecutionPolicy: '{"mode":"collective_participation"}' }));
    await f.recover();
    assert.equal(injected, true);
    if (race === 'terminal-wins') {
      assert.equal(await f.redis.hget('auth:inv:old', 'state'), 'completed');
      assert.equal(await f.redis.hget('auth:inv:old', 'endReason'), 'provider-won');
      assert.equal(await f.redis.hget('auth:inv:old', 'endedAt'), '3000');
    } else assert.equal(await f.redis.exists('auth:inv:old'), 0);
    assert.equal((await f.probe(f.fresh)).statusCode, 200);
  });
}

for (const extra of [
  ...['executionGrant', 'collectiveWorkBinding'].flatMap((field) =>
    ['active', 'completed'].map((state) => ({ state, [field]: '{}', toolExecutionPolicy: '' })),
  ),
  { toolExecutionPolicy: '{"mode":"future_unknown"}' },
  { toolExecutionPolicy: '{"mode":"read_only","replayDeniedToolNames":[1]}' },
  { toolExecutionPolicy: '{"mode":"collective_work"}', recordSchemaVersion: '999', principalKind: 'ordinary' },
  { toolExecutionPolicy: '{"mode":"collective_work"}', callbackToken: '' },
]) {
  test(`actual recovery stays closed for corrupt metadata: ${JSON.stringify(extra)}`, { skip: SKIP }, async (t) => {
    const f = await fixture(t);
    const raw = legacyHash(extra);
    await seed(f.redis, raw);
    await assert.rejects(() => f.recover(), /corrupt callback auth record/);
    assert.equal(f.registry.isStartupRecoveryComplete(), false);
    assert.equal((await f.probe(f.fresh)).statusCode, 503);
    assert.deepEqual(await f.redis.hgetall('auth:inv:old'), raw);
  });
}

for (const state of ['active', 'completed']) {
  test(
    `migration never follows a mismatched ${state} hash identity into another credential`,
    { skip: SKIP },
    async (t) => {
      const f = await fixture(t);
      const victimKey = `auth:inv:${f.fresh.invocationId}`;
      const before = await f.redis.hgetall(victimKey);
      const forged = legacyHash({
        invocationId: f.fresh.invocationId,
        state,
        toolExecutionPolicy: '{"mode":"collective_participation"}',
      });
      await f.redis.hset('auth:inv:alias', ...Object.entries(forged).flat());
      await assert.rejects(() => f.recover(), /corrupt callback auth record/);
      assert.equal(f.registry.isStartupRecoveryComplete(), false);
      assert.deepEqual(await f.redis.hgetall(victimKey), before);
      assert.deepEqual(await f.redis.hgetall('auth:inv:alias'), forged);
    },
  );
}

for (const field of ['threadId', 'catId', 'userId']) {
  test(`retired active migration requires its original ${field} binding`, { skip: SKIP }, async (t) => {
    const f = await fixture(t);
    const raw = legacyHash({ state: 'active', [field]: '', toolExecutionPolicy: '{"mode":"collective_work"}' });
    await seed(f.redis, raw);
    await assert.rejects(() => f.recover(), /corrupt callback auth record/);
    assert.equal(f.registry.isStartupRecoveryComplete(), false);
    assert.deepEqual(await f.redis.hgetall('auth:inv:old'), raw);
  });
}
