import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

function runningInput(overrides = {}) {
  return {
    invocationId: 'redis-child-1',
    parentInvocationId: 'redis-parent-1',
    threadId: 'redis-thread-1',
    userId: 'redis-user-1',
    catId: 'codex-sol',
    executionKind: 'ordinary',
    startedAt: 100,
    causal: { triggerMessageId: 'redis-msg-1' },
    ...overrides,
  };
}

describe('RedisTurnExecutionStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisTurnExecutionStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisTurnExecutionStore');
    ({ RedisTurnExecutionStore } = await import(
      '../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js'
    ));
    ({ createRedisClient } = await import('@cat-cafe/shared/utils'));
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
      store = new RedisTurnExecutionStore(redis);
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  after(async () => {
    if (!connected) return;
    await cleanupPrefixedRedisKeys(redis, ['turnexec:*', 'auth:inv:*', 'auth:latest:*']);
    await redis.quit();
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['turnexec:*', 'auth:inv:*', 'auth:latest:*']);
    store = new RedisTurnExecutionStore(redis);
  });

  test('persists running child and parent index across store instances', async () => {
    await store.createRunning(runningInput({ invocationId: 'later', startedAt: 200 }));
    await store.createRunning(runningInput({ invocationId: 'earlier', startedAt: 100 }));

    const restarted = new RedisTurnExecutionStore(redis);
    assert.deepEqual(
      (await restarted.listByParent('redis-parent-1')).map((record) => record.invocationId),
      ['earlier', 'later'],
    );
    assert.equal((await restarted.get('earlier')).status, 'running');
    assert.equal(await redis.ttl('turnexec:record:earlier'), -1, 'ledger records are TTL=0 persistent truth');
  });

  test('atomic create replays same identity and rejects child-id identity drift', async () => {
    const input = runningInput();
    assert.equal((await store.createRunning(input)).outcome, 'created');
    assert.equal(
      (await store.createRunning({ ...input, causal: { triggerMessageId: 'redis-msg-1' } })).outcome,
      'replayed',
    );
    assert.equal((await store.createRunning({ ...input, executionKind: 'routing_guard' })).outcome, 'conflict');
    assert.equal((await store.get(input.invocationId)).executionKind, 'ordinary');
  });

  test('atomic create canonicalizes causal field order', async () => {
    const input = runningInput({
      executionKind: 'freshness_supplement',
      causal: { triggerMessageId: 'redis-msg-1', freshnessSupplementId: 'redis-supplement-1' },
    });
    assert.equal((await store.createRunning(input)).outcome, 'created');
    assert.equal(
      (
        await store.createRunning({
          ...input,
          causal: { freshnessSupplementId: 'redis-supplement-1', triggerMessageId: 'redis-msg-1' },
        })
      ).outcome,
      'replayed',
    );
  });

  test('prompt coverage is an immutable causal set across Redis restart', async () => {
    const input = runningInput({
      causal: {
        triggerMessageId: 'redis-msg-1',
        coveredMessageIds: ['redis-msg-1', 'redis-context-1'],
      },
    });
    assert.equal((await store.createRunning(input)).outcome, 'created');

    const restarted = new RedisTurnExecutionStore(redis);
    assert.equal(
      (
        await restarted.createRunning({
          ...input,
          causal: {
            coveredMessageIds: ['redis-context-1', 'redis-msg-1'],
            triggerMessageId: 'redis-msg-1',
          },
        })
      ).outcome,
      'replayed',
    );
    assert.equal(
      (
        await restarted.createRunning({
          ...input,
          causal: {
            triggerMessageId: 'redis-msg-1',
            coveredMessageIds: ['redis-msg-1', 'redis-other'],
          },
        })
      ).outcome,
      'conflict',
    );
    assert.deepEqual((await restarted.get(input.invocationId)).causal.coveredMessageIds, [
      'redis-msg-1',
      'redis-context-1',
    ]);
  });

  test('two store instances racing success and cancel produce one immutable terminal', async () => {
    await store.createRunning(runningInput());
    const competitor = new RedisTurnExecutionStore(redis);
    const [success, canceled] = await Promise.all([
      store.transitionTerminal('redis-child-1', { status: 'succeeded', endedAt: 300 }),
      competitor.transitionTerminal('redis-child-1', {
        status: 'canceled',
        endedAt: 301,
        terminalReason: 'user_cancel',
      }),
    ]);

    assert.deepEqual([success.outcome, canceled.outcome].sort(), ['already_terminal', 'transitioned']);
    const terminal = await store.get('redis-child-1');
    const duplicate = await competitor.transitionTerminal('redis-child-1', {
      status: terminal.status === 'succeeded' ? 'failed' : 'succeeded',
      endedAt: 400,
      ...(terminal.status === 'succeeded' ? { terminalReason: 'late_error' } : {}),
    });
    assert.equal(duplicate.outcome, 'already_terminal');
    assert.deepEqual(await competitor.get('redis-child-1'), terminal);
    assert.deepEqual(await redis.smembers('turnexec:running'), []);
  });

  test('auth cleanup does not delete child execution history', async () => {
    await store.createRunning(runningInput());
    await redis.hset('auth:inv:redis-child-1', { invocationId: 'redis-child-1', callbackToken: 'secret' });
    await redis.set('auth:latest:redis-thread-1:codex-sol', 'redis-child-1');

    await redis.del('auth:inv:redis-child-1', 'auth:latest:redis-thread-1:codex-sol');

    assert.equal(await redis.exists('auth:inv:redis-child-1'), 0);
    assert.equal((await store.get('redis-child-1')).invocationId, 'redis-child-1');
    assert.deepEqual(
      (await store.listByParent('redis-parent-1')).map((record) => record.invocationId),
      ['redis-child-1'],
    );
  });

  test('corrupt durable hashes fail explicitly instead of disappearing from glass-box truth', async () => {
    await redis.hset('turnexec:record:corrupt-child', {
      invocationId: 'corrupt-child',
      parentInvocationId: 'redis-parent-1',
      threadId: 'redis-thread-1',
      userId: 'redis-user-1',
      catId: 'codex-sol',
      executionKind: 'guessed-from-log',
      startedAt: 'not-a-number',
      causal: '{}',
      status: 'maybe-done',
      endedAt: '',
      terminalReason: '',
    });

    await assert.rejects(() => store.get('corrupt-child'), /corrupt turn execution record: corrupt-child/);
  });

  test('create rejects an existing partial hash instead of silently repairing child identity', async () => {
    await redis.hset('turnexec:record:redis-child-1', { partialEvidence: 'preserve-me' });

    await assert.rejects(
      () => store.createRunning(runningInput()),
      /corrupt turn execution record already exists: redis-child-1/,
    );

    assert.equal(await redis.hget('turnexec:record:redis-child-1', 'partialEvidence'), 'preserve-me');
    assert.equal(await redis.hget('turnexec:record:redis-child-1', 'immutableIdentity'), null);
    assert.deepEqual(await redis.smembers('turnexec:parent:redis-parent-1'), []);
  });

  test('immutable identity detects field tampering in direct and parent-index reads', async () => {
    await store.createRunning(runningInput());
    await redis.hset('turnexec:record:redis-child-1', 'executionKind', 'routing_guard');

    await assert.rejects(() => store.get('redis-child-1'), /corrupt turn execution record: redis-child-1/);
    await assert.rejects(() => store.listByParent('redis-parent-1'), /corrupt turn execution record: redis-child-1/);
  });

  test('interruptRunningBefore is cutoff-safe and atomically removes running index members', async () => {
    await store.createRunning(runningInput({ invocationId: 'old', startedAt: 99 }));
    await store.createRunning(runningInput({ invocationId: 'boundary', startedAt: 100 }));
    await store.createRunning(runningInput({ invocationId: 'new', startedAt: 101 }));

    const interrupted = await store.interruptRunningBefore(101, {
      endedAt: 200,
      terminalReason: 'process_restart',
    });

    assert.deepEqual(
      interrupted.map((record) => record.invocationId),
      ['old', 'boundary'],
    );
    assert.equal((await store.get('old')).status, 'interrupted');
    assert.equal((await store.get('boundary')).status, 'interrupted');
    assert.equal((await store.get('new')).status, 'running');
    assert.deepEqual(await redis.smembers('turnexec:running'), ['new']);
  });
});
