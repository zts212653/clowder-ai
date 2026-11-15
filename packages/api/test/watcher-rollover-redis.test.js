import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { RedisSessionChainStore } from '../dist/domains/cats/services/stores/redis/RedisSessionChainStore.js';
import { clearAuthTestNamespace, createAuthTestNamespace } from './helpers/redis-auth-namespace.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';
import { watcherRolloverCases } from './helpers/watcher-rollover-cases.js';

describe('watcher rollover Redis persistence', { skip: redisIsolationSkipReason(process.env.REDIS_URL) }, () => {
  const namespace = createAuthTestNamespace('watcher-rollover');
  let redis;
  before(async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'watcher rollover');
    redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: namespace });
    await redis.ping();
  });
  after(async () => {
    if (redis) {
      await clearAuthTestNamespace(redis, namespace);
      await redis.quit();
    }
  });
  watcherRolloverCases(() => new RedisSessionChainStore(redis));

  test('a new Redis process retains exhausted retirement discovery and atomically replays the same successor with TTL=0', async () => {
    const sessions = new RedisSessionChainStore(redis);
    const { watcherSessionChainKey } = await import('../dist/domains/cats/services/session/session-scope.js');
    const old = await sessions.create({
      userId: 'restart-owner',
      catId: 'codex',
      threadId: 'restart-line',
      sessionPurpose: 'watcher',
      cliSessionId: 'old-restart-native',
      chainKey: watcherSessionChainKey('restart-owner', 'codex', 'restart-line'),
    });
    const operation = {
      id: 'restart-retirement',
      wakeInvocationId: 'restart-wake',
      sourceInvocationId: 'restart-source',
      sourceSequence: 55,
      oldSchemaHash: 'a'.repeat(64),
      nativeCliSessionId: old.cliSessionId,
      phase: 'pending',
      probes: 3,
      lastFailure: 'native unknown',
    };
    await sessions.compareAndSetWatcherState(
      old.id,
      0,
      {
        revision: 1,
        afterSequence: 54,
        notes: 'restart notes',
        consumedThrough: 'old-original',
        messageOffset: 1240,
        activationCut: '0:1',
        toolSchemaHash: operation.oldSchemaHash,
      },
      operation,
    );
    const script = String.raw`
    import assert from 'node:assert/strict';
    import { createRedisClient } from '@cat-cafe/shared/utils';
    import { RedisSessionChainStore } from './dist/domains/cats/services/stores/redis/RedisSessionChainStore.js';
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: process.env.RETIRE_NAMESPACE });
    try {
      const sessions = new RedisSessionChainStore(redis);
      const old = await sessions.get(process.env.RETIRE_SESSION);
      const op = old.watcherRetirement;
      assert.equal(op.probes, 3);
      if (op.phase === 'pending') assert.equal((await sessions.listPendingWatcherSessions(old.userId))[0].id, old.id);
      const next = await sessions.rolloverWatcherSession({ sessionId: old.id, expectedRevision: old.watcherState.revision,
        expectedCliSessionId: old.cliSessionId, expectedNativeSessionBinding: old.nativeSessionBinding, retirementId: op.id });
      if (op.phase === 'pending') assert.equal(next, null);
      else {
        assert.equal(next.watcherState.messageOffset, 1240); assert.equal(next.watcherState.activationCut, '0:1');
        assert.equal(next.cliSessionId, undefined); assert.equal(next.watcherState.toolSchemaHash, undefined);
        assert.equal(await redis.ttl('session:' + next.id), -1);
      }
      process.stdout.write('RETIRE_RESULT ' + JSON.stringify({ successor: next?.id ?? null }) + '\n');
    } finally { await redis.quit(); }
  `;
    const child = () => {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, LOG_LEVEL: 'silent', RETIRE_SESSION: old.id, RETIRE_NAMESPACE: namespace },
      });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      return JSON.parse(
        result.stdout
          .split('\n')
          .find((line) => line.startsWith('RETIRE_RESULT '))
          .slice('RETIRE_RESULT '.length),
      );
    };
    assert.equal(child().successor, null);
    const current = await sessions.get(old.id);
    await sessions.compareAndSetWatcherState(
      old.id,
      1,
      { ...current.watcherState, revision: 2 },
      { ...operation, phase: 'idle' },
    );
    const { SessionChainKeys } = await import('../dist/domains/cats/services/stores/redis-keys/session-chain-keys.js');
    const pendingKey = SessionChainKeys.watcherPending(old.userId);
    const beforeRollover = await sessions.get(old.id);
    await redis.del(pendingKey);
    await redis.set(pendingKey, 'fixture wrong index type');
    try {
      await assert.rejects(
        sessions.rolloverWatcherSession({
          sessionId: old.id,
          expectedRevision: beforeRollover.watcherState.revision,
          expectedCliSessionId: old.cliSessionId,
          expectedNativeSessionBinding: undefined,
          retirementId: operation.id,
        }),
      );
      assert.deepEqual(await sessions.get(old.id), beforeRollover, 'an index error must precede every rollover write');
      assert.equal((await sessions.getByChainKey(old.chainKey)).id, old.id);
    } finally {
      await redis.del(pendingKey);
      await redis.sadd(pendingKey, old.id);
    }
    const first = child().successor;
    assert.ok(first);
    assert.equal(child().successor, first);
    assert.deepEqual(await sessions.listPendingWatcherSessions(old.userId), []);
  });
});
