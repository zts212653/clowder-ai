import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const SKIP = redisIsolationSkipReason(REDIS_URL);
const KEY_PREFIX = 'cat-cafe-f298-auth-lifecycle-test:';
let redis;
let createRedisClient;
let RedisAuthInvocationBackend;
let InvocationRegistry;
let registerCallbackAuthHook;
let MIGRATE_AUTH_SLOT_LUA;

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!Number.isInteger(port) || port <= 0 || port === 6399) throw new Error('failed to reserve safe Redis test port');
  return port;
}

async function startAofRedis(port, dataDir) {
  const output = [];
  const child = spawn(
    'redis-server',
    [
      '--port',
      String(port),
      '--bind',
      '127.0.0.1',
      '--protected-mode',
      'no',
      '--databases',
      '16',
      '--dir',
      dataDir,
      '--appendonly',
      'yes',
      '--appendfsync',
      'always',
      '--save',
      '',
      '--daemonize',
      'no',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  const client = createRedisClient({ url: `redis://127.0.0.1:${port}/15`, keyPrefix: 'f298-aof:' });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await client.ping()) === 'PONG') return { child, client };
    } catch {
      if (child.exitCode !== null) break;
      await delay(20);
    }
  }
  await client.quit().catch(() => {});
  child.kill('SIGTERM');
  throw new Error(`private AOF Redis failed to start: ${output.join('').slice(-2_000)}`);
}

async function stopAofRedis(instance) {
  if (!instance) return;
  await instance.client.shutdown('nosave').catch(() => {});
  if (instance.child.exitCode === null) {
    await Promise.race([once(instance.child, 'exit'), delay(2_000)]);
  }
  if (instance.child.exitCode === null) instance.child.kill('SIGTERM');
}

before(async () => {
  if (SKIP) return;
  assertRedisIsolationOrThrow(REDIS_URL, 'f298-callback-auth-lifecycle-redis');
  ({ createRedisClient } = await import('@cat-cafe/shared/utils'));
  ({ RedisAuthInvocationBackend } = await import(
    '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.js'
  ));
  ({ InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'));
  ({ registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js'));
  ({ MIGRATE_AUTH_SLOT_LUA } = await import(
    '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationLua.js'
  ));
  redis = createRedisClient({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
  await cleanupClientKeyspace(redis);
});

afterEach(async () => {
  if (redis) await cleanupClientKeyspace(redis);
});

after(async () => {
  if (redis) await redis.quit();
});

describe('F298 Redis callback auth lifecycle', { skip: SKIP }, () => {
  test('active record, dedup set, and latest pointer all remain TTL=0', async () => {
    const registry = new InvocationRegistry({ backend: new RedisAuthInvocationBackend(redis) });
    const credentials = await registry.create('user-1', 'codex-sol', 'thread-1');
    await registry.claimClientMessageId(credentials.invocationId, 'client-1');
    assert.equal((await registry.verify(credentials.invocationId, credentials.callbackToken)).ok, true);

    assert.equal(await redis.pttl(`auth:inv:${credentials.invocationId}`), -1);
    assert.equal(await redis.pttl(`auth:inv:${credentials.invocationId}:msgs`), -1);
    assert.equal(await redis.pttl('auth:latest:thread-1:codex-sol'), -1);
  });

  test('active callback principal and dedup state survive a real AOF restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'f298-aof-restart-'));
    const port = await reserveLoopbackPort();
    let first;
    let restarted;
    try {
      first = await startAofRedis(port, dataDir);
      const before = new InvocationRegistry({
        backend: new RedisAuthInvocationBackend(first.client),
      });
      const credentials = await before.create('user-1', 'codex-sol', 'thread-aof');
      await before.claimClientMessageId(credentials.invocationId, 'client-aof');
      await stopAofRedis(first);
      first = undefined;

      restarted = await startAofRedis(port, dataDir);
      const afterRestart = new InvocationRegistry({
        backend: new RedisAuthInvocationBackend(restarted.client),
      });
      assert.equal((await afterRestart.verify(credentials.invocationId, credentials.callbackToken)).ok, true);
      assert.equal(await restarted.client.pttl(`auth:inv:${credentials.invocationId}`), -1);
      assert.equal(await restarted.client.pttl(`auth:inv:${credentials.invocationId}:msgs`), -1);
      assert.equal(await restarted.client.pttl('auth:latest:thread-aof:codex-sol'), -1);
      assert.equal(await afterRestart.claimClientMessageId(credentials.invocationId, 'client-aof'), false);
    } finally {
      await stopAofRedis(first);
      await stopAofRedis(restarted);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test('concurrent terminal commits preserve one physical first write', async () => {
    const registry = new InvocationRegistry({ backend: new RedisAuthInvocationBackend(redis) });
    const credentials = await registry.create('user-1', 'codex-sol', 'thread-1');
    const terminalRef = `turn_execution:${credentials.invocationId}`;

    const results = await Promise.all([
      registry.commitTerminal({
        invocationId: credentials.invocationId,
        disposition: 'failed',
        endedAt: 2_000,
        endReason: 'provider_error',
        terminalRef,
      }),
      registry.commitTerminal({
        invocationId: credentials.invocationId,
        disposition: 'canceled',
        endedAt: 2_001,
        endReason: 'user_cancel',
        terminalRef,
      }),
    ]);

    assert.equal(results.filter((result) => result.outcome === 'committed').length, 1);
    assert.equal(results.filter((result) => result.outcome === 'already_terminal').length, 1);
    const stored = await registry.peekRecord(credentials.invocationId);
    assert.ok(stored.state === 'failed' || stored.state === 'canceled');
    assert.ok((await redis.pttl(`auth:inv:${credentials.invocationId}`)) > 0);
  });

  test('same-slot replacement is atomically visible and old auth is typed replaced', async () => {
    const registry = new InvocationRegistry({ backend: new RedisAuthInvocationBackend(redis) });
    const first = await registry.create('user-1', 'codex-sol', 'thread-1');
    const second = await registry.create('user-1', 'codex-sol', 'thread-1');

    assert.deepEqual(await registry.verify(first.invocationId, first.callbackToken), {
      ok: false,
      reason: 'replaced',
    });
    assert.equal(await registry.getLatestId('thread-1', 'codex-sol'), second.invocationId);
    assert.equal(await redis.pttl('auth:latest:thread-1:codex-sol'), -1);
  });

  test('startup migration persists the latest legacy active record and tombstones older slot members', async () => {
    const expiresAt = Date.now() + 60_000;
    for (const [invocationId, callbackToken, createdAt] of [
      ['legacy-old', 'token-old', 100],
      ['legacy-new', 'token-new', 200],
    ]) {
      await redis.hset(
        `auth:inv:${invocationId}`,
        'invocationId',
        invocationId,
        'callbackToken',
        callbackToken,
        'userId',
        'user-1',
        'ownerAuthProvenance',
        'strict',
        'catId',
        'codex-sol',
        'threadId',
        'thread-legacy',
        'createdAt',
        String(createdAt),
        'expiresAt',
        String(expiresAt),
      );
      await redis.sadd(`auth:inv:${invocationId}:msgs`, `message-${invocationId}`);
      await redis.pexpire(`auth:inv:${invocationId}`, 60_000);
      await redis.pexpire(`auth:inv:${invocationId}:msgs`, 60_000);
    }

    const registry = new InvocationRegistry({ backend: new RedisAuthInvocationBackend(redis) });
    const migration = await registry.migrateLegacyRecords();

    assert.deepEqual(migration, { scanned: 2, persistedActive: 2, replaced: 1, rebuiltLatest: 1 });
    assert.deepEqual(await registry.verify('legacy-old', 'token-old'), { ok: false, reason: 'replaced' });
    const latest = await registry.verify('legacy-new', 'token-new');
    assert.equal(latest.ok, true);
    assert.equal(latest.record.expiresAt, null);
    assert.equal(await redis.pttl('auth:inv:legacy-new'), -1);
    assert.equal(await redis.pttl('auth:inv:legacy-new:msgs'), -1);
    assert.equal(await redis.pttl('auth:latest:thread-legacy:codex-sol'), -1);
    assert.ok((await redis.pttl('auth:inv:legacy-old')) > 0, 'terminal tombstone retains a finite GC TTL');
  });

  test('startup migration is atomic against a concurrent latest and callbacks stay closed until it commits', async () => {
    const expiresAt = Date.now() + 60_000;
    for (const [invocationId, callbackToken, createdAt] of [
      ['legacy-old', 'token-old', 100],
      ['legacy-new', 'token-new', 200],
    ]) {
      await redis.hset(
        `auth:inv:${invocationId}`,
        'invocationId',
        invocationId,
        'callbackToken',
        callbackToken,
        'userId',
        'user-1',
        'ownerAuthProvenance',
        'strict',
        'catId',
        'codex-sol',
        'threadId',
        'thread-race',
        'createdAt',
        String(createdAt),
        'expiresAt',
        String(expiresAt),
      );
    }

    const concurrentRegistry = new InvocationRegistry({ backend: new RedisAuthInvocationBackend(redis) });
    let current;
    let injectedConcurrentLatest = false;
    const racingRedis = new Proxy(redis, {
      get(target, property) {
        if (property === 'eval') {
          return async (...args) => {
            if (!injectedConcurrentLatest && args[0] === MIGRATE_AUTH_SLOT_LUA) {
              injectedConcurrentLatest = true;
              current = await concurrentRegistry.create('user-1', 'codex-sol', 'thread-race');
            }
            return target.eval(...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const registry = new InvocationRegistry({
      backend: new RedisAuthInvocationBackend(racingRedis),
      startupRecoveryRequired: true,
    });
    const app = Fastify({ logger: false });
    registerCallbackAuthHook(app, registry);
    app.get('/api/callbacks/race-probe', async () => ({ ok: true }));
    await app.ready();

    const migrationPromise = registry.migrateLegacyRecords();
    const during = await app.inject({
      method: 'GET',
      url: '/api/callbacks/race-probe',
      headers: { 'x-invocation-id': 'legacy-old', 'x-callback-token': 'token-old' },
    });
    assert.equal(during.statusCode, 503);
    assert.equal(during.json().reason, 'startup_recovery_pending');

    const migration = await migrationPromise;
    registry.markStartupRecoveryComplete();
    assert.equal(injectedConcurrentLatest, true, 'test must install a new latest after the migration snapshot');
    assert.deepEqual(migration, { scanned: 2, persistedActive: 2, replaced: 2, rebuiltLatest: 0 });
    assert.equal(await registry.getLatestId('thread-race', 'codex-sol'), current.invocationId);
    assert.deepEqual(await registry.verify('legacy-old', 'token-old'), { ok: false, reason: 'replaced' });
    assert.deepEqual(await registry.verify('legacy-new', 'token-new'), { ok: false, reason: 'replaced' });
    assert.equal((await registry.verify(current.invocationId, current.callbackToken)).ok, true);

    await app.close();
  });
});
