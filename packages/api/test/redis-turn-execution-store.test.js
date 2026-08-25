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

  test('atomically binds late prompt coverage across competing store instances', async () => {
    const input = runningInput();
    await store.createRunning(input);
    const competitor = new RedisTurnExecutionStore(redis);
    const [first, second] = await Promise.all([
      store.bindCoveredMessageIds('redis-child-1', ['redis-msg-1', 'redis-context-1']),
      competitor.bindCoveredMessageIds('redis-child-1', ['redis-msg-1', 'redis-context-1']),
    ]);

    assert.deepEqual([first.outcome, second.outcome].sort(), ['bound', 'replayed']);
    assert.equal((await competitor.bindCoveredMessageIds('redis-child-1', ['redis-other'])).outcome, 'conflict');
    assert.deepEqual((await competitor.get('redis-child-1')).causal.coveredMessageIds, [
      'redis-msg-1',
      'redis-context-1',
    ]);
    assert.equal(
      (await competitor.bindCoveredMessageIds('redis-child-1', ['redis-context-1', 'redis-msg-1'])).outcome,
      'replayed',
    );
    assert.equal((await competitor.createRunning(input)).outcome, 'replayed');
  });

  test('late prompt coverage preserves the legacy hash identity for mixed-version readers', async () => {
    const input = runningInput();
    await store.createRunning(input);
    const recordKey = 'turnexec:record:redis-child-1';
    const legacyCausal = await redis.hget(recordKey, 'causal');
    const legacyIdentity = await redis.hget(recordKey, 'immutableIdentity');

    assert.equal(
      (await store.bindCoveredMessageIds(input.invocationId, ['redis-context-1', 'redis-msg-1'])).outcome,
      'bound',
    );

    assert.equal(await redis.hget(recordKey, 'causal'), legacyCausal);
    assert.equal(await redis.hget(recordKey, 'immutableIdentity'), legacyIdentity);
    assert.equal(await redis.hget(recordKey, 'coveredMessageIds'), '["redis-context-1","redis-msg-1"]');
    assert.ok(await redis.hget(recordKey, 'coveredMessageIdsIdentity'));
  });

  test('binds late prompt coverage when the admitted execution had no causal refs', async () => {
    const input = runningInput({ causal: undefined });
    await store.createRunning(input);

    assert.equal((await store.bindCoveredMessageIds(input.invocationId, ['redis-msg-1'])).outcome, 'bound');
    assert.deepEqual((await store.get(input.invocationId)).causal, { coveredMessageIds: ['redis-msg-1'] });
    assert.equal((await store.createRunning(input)).outcome, 'replayed');
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

  test('late-bound coverage identity detects tampering without rewriting legacy causal identity', async () => {
    await store.createRunning(runningInput());
    await store.bindCoveredMessageIds('redis-child-1', ['redis-msg-1', 'redis-context-1']);
    await redis.hset('turnexec:record:redis-child-1', 'coveredMessageIds', JSON.stringify(['redis-other']));

    await assert.rejects(() => store.get('redis-child-1'), /corrupt turn execution record: redis-child-1/);
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

  test('interruptRunningBefore preserves an exact externally-owned child', async () => {
    await store.createRunning(runningInput({ invocationId: 'detached-live', startedAt: 90 }));
    await store.createRunning(runningInput({ invocationId: 'lost-run', startedAt: 91 }));

    const interrupted = await store.interruptRunningBefore(100, {
      endedAt: 200,
      terminalReason: 'process_restart',
      excludedInvocationIds: ['detached-live'],
    });

    assert.deepEqual(
      interrupted.map((record) => record.invocationId),
      ['lost-run'],
    );
    assert.equal((await store.get('detached-live')).status, 'running');
    assert.equal((await store.get('lost-run')).status, 'interrupted');
  });

  test('F297 P1-2: listRunningByUser scopes to owner, drops terminal, survives restart', async () => {
    await store.createRunning(runningInput({ invocationId: 'mine-1', userId: 'alice', startedAt: 100 }));
    await store.createRunning(
      runningInput({ invocationId: 'mine-2', userId: 'alice', threadId: 'redis-thread-2', startedAt: 200 }),
    );
    await store.createRunning(runningInput({ invocationId: 'theirs', userId: 'bob', startedAt: 150 }));
    await store.createRunning(runningInput({ invocationId: 'mine-done', userId: 'alice', startedAt: 50 }));
    await store.transitionTerminal('mine-done', { status: 'succeeded', endedAt: 300 });

    // 跨实例读：Sidebar 的 presence 查询走的是新连接，不是写入方的进程内状态。
    const restarted = new RedisTurnExecutionStore(redis);
    assert.deepEqual(
      (await restarted.listRunningByUser('alice')).map((record) => record.invocationId),
      ['mine-1', 'mine-2'],
    );
    assert.deepEqual(await restarted.listRunningByUser('carol'), []);
  });

  test('F297 P1-2: listRunningByUser reaches a child whose parent index is unreachable', async () => {
    await store.createRunning(runningInput({ invocationId: 'orphan', parentInvocationId: 'redis-parent-absent' }));

    const running = await store.listRunningByUser('redis-user-1');
    assert.deepEqual(
      running.map((record) => record.invocationId),
      ['orphan'],
      'the enumerator must not depend on a running parent record being reachable',
    );
  });

  test('F297 P1-2: listRunningByUser is observational — it never terminalizes a stale member', async () => {
    await store.createRunning(runningInput({ invocationId: 'stale', userId: 'alice' }));
    // 模拟 record 被清掉但 running 集合残留：观测路径必须跳过，且不得改写任何状态。
    await redis.del('turnexec:record:stale');

    assert.deepEqual(await store.listRunningByUser('alice'), []);
    assert.equal(
      await redis.sismember('turnexec:running', 'stale'),
      1,
      'the observation path must not perform terminal cleanup writes',
    );
  });

  test('F297 (cloud R9 P1): a missing pipeline reply is a read failure, not a stale member', async () => {
    await store.createRunning(runningInput({ invocationId: 'short-1', userId: 'alice' }));

    // 缺失/短回复既不是"空 hash"（stale 索引成员）也不是"在跑"——是未知。
    // 静默 continue 会让真实 running child 消失，而方法仍正常 resolve：
    // buildSnapshot 把 child 源记成 complete → sidebar 直接走终态回落 = false terminal。
    const originalPipeline = redis.pipeline.bind(redis);
    redis.pipeline = () => {
      const p = originalPipeline();
      p.exec = async () => []; // 候选 1 个，回复 0 条
      return p;
    };
    try {
      await assert.rejects(
        () => store.listRunningByUser('alice'),
        /reply missing/i,
        'a missing pipeline entry must fail closed so completeness accounting can seal idle',
      );
    } finally {
      redis.pipeline = originalPipeline;
    }
  });

  test('F297 (cloud R9 P1): an explicit empty hash is still treated as a stale index member', async () => {
    // fail-closed 不能过度扩张：running set 里指向已删记录的成员仍应被跳过，
    // 否则一个正常的 GC 窗口就会让整个 sidebar 读路径抛错。
    await redis.sadd('turnexec:running', 'ghost-child');
    const records = await store.listRunningByUser('alice');
    assert.deepEqual(
      records.map((r) => r.invocationId),
      [],
      'an empty hash means the record is gone, which is authoritative — not a read failure',
    );
  });

  test('F297 (local R10 P1): negative table — only an authoritative empty hash may mean "not running"', async () => {
    // 判据单一来源 readAuthoritativeHash：
    //   缺 entry / entry error / null / 非 plain object / 非空但不可 hydrate → throw（未知）
    //   plain `{}` → 权威空（记录已删）
    // 把未知降成「没在跑」就是 false terminal —— 本 PR 反复重犯的同一个失败模式。
    await store.createRunning(runningInput({ invocationId: 'neg-child', userId: 'alice' }));

    const originalPipeline = redis.pipeline.bind(redis);
    const withReply = (reply) => {
      redis.pipeline = () => {
        const p = originalPipeline();
        p.exec = async () => reply;
        return p;
      };
    };

    try {
      const unknownReplies = [
        ['short reply (missing entry)', []],
        ['entry error', [[new Error('transient-read'), null]]],
        ['null payload', [[null, null]]],
        ['string payload', [[null, 'wrong-type']]],
        ['array payload', [[null, []]]],
        ['non-empty unhydratable hash', [[null, { foo: 'bar' }]]],
      ];
      for (const [label, reply] of unknownReplies) {
        withReply(reply);
        await assert.rejects(
          () => store.listRunningByUser('alice'),
          (err) => err instanceof Error,
          `an unknown reply must fail closed, not resolve empty: ${label}`,
        );
      }

      withReply([[null, {}]]);
      assert.deepEqual(
        await store.listRunningByUser('alice'),
        [],
        'an authoritative empty hash is the only legitimate "not running"',
      );
    } finally {
      redis.pipeline = originalPipeline;
    }
  });
});
