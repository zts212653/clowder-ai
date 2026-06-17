/**
 * F233 Phase A — collect 层 Redis-backed 测试（Task 2.5）。
 * 验证真实 Redis 查询行为（in-memory 遍历掩盖的索引选择 / scanAll），feedback_inmemory 教训。
 * - collectTasks: listByKind('work') Redis kind 索引
 * - collectZombies: scanAll(Redis-only) + draft freshness 判定（now 注入模拟老 record）
 * AC-A5 只读：collector 仅调读方法（listByKind/scanAll/getByThread），无写。
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('F233 collect 层 — Redis-backed (Task 2.5)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisTaskStore;
  let RedisInvocationRecordStore;
  let createRedisClient;
  let collectTasks;
  let collectZombies;
  let redis;
  let connected = false;

  const CLEAN = ['task:*', 'tasks:*', 'invoc:*'];

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F233Collect');
    RedisTaskStore = (await import('../dist/domains/cats/services/stores/redis/RedisTaskStore.js')).RedisTaskStore;
    RedisInvocationRecordStore = (
      await import('../dist/domains/cats/services/stores/redis/RedisInvocationRecordStore.js')
    ).RedisInvocationRecordStore;
    const mod = await import('../dist/domains/cats/services/duty-briefing/collectDutyBriefingInput.js');
    collectTasks = mod.collectTasks;
    collectZombies = mod.collectZombies;
    createRedisClient = (await import('@cat-cafe/shared/utils')).createRedisClient;
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, CLEAN);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, CLEAN);
  });

  it('collectTasks: listByKind(work) 取到 blocked task，字段映射对', async () => {
    const store = new RedisTaskStore(redis, { ttlSeconds: 120 });
    const t1 = await store.create({
      threadId: 'thr-1',
      title: '启用 Repo Inbox',
      why: '等 You 重启 API',
      createdBy: 'codex',
    });
    await store.update(t1.id, { status: 'blocked' });
    await store.create({ threadId: 'thr-2', title: '正常事项', why: '', createdBy: 'opus' });

    const tasks = await collectTasks(store, 'default-user');
    assert.equal(tasks.length, 2, 'listByKind work 取到两个 default-user task');
    const repoInbox = tasks.find((t) => t.title === '启用 Repo Inbox');
    assert.ok(repoInbox, '取到 blocked task');
    assert.equal(repoInbox.status, 'blocked');
    assert.equal(repoInbox.threadId, 'thr-1');
    assert.equal(repoInbox.why, '等 You 重启 API');
    assert.ok(repoInbox.updatedAt > 0);
  });

  it('collectZombies: scanAll(Redis-only) running 无 fresh draft 超 grace → zombie', async () => {
    const store = new RedisInvocationRecordStore(redis);
    const created = await store.create({
      threadId: 'thr-f167',
      userId: 'default-user',
      targetCats: ['opus-47'],
      intent: 'execute',
      idempotencyKey: 'idem-1',
    });
    await store.update(created.invocationId, { status: 'running' });

    const emptyDraftStore = { getByThread: async () => [] };
    const future = Date.now() + 700_000; // record age >600s grace
    const { zombies, runningCount, runningZombieCount } = await collectZombies(
      store,
      emptyDraftStore,
      'default-user',
      future,
    );
    assert.equal(runningCount, 1, 'scanAll 找到 running record');
    assert.equal(runningZombieCount, 1, 'stale running 计入 runningZombieCount');
    assert.equal(zombies.length, 1, '无 fresh draft + 超 grace → zombie');
    assert.equal(zombies[0].catId, 'opus-47');
    assert.equal(zombies[0].threadId, 'thr-f167');
    assert.equal(zombies[0].invocationId, created.invocationId);
  });

  it('collectZombies: running 在 grace 内（年轻）→ 不误判 zombie', async () => {
    const store = new RedisInvocationRecordStore(redis);
    const created = await store.create({
      threadId: 'thr-x',
      userId: 'default-user',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'idem-2',
    });
    await store.update(created.invocationId, { status: 'running' });
    const emptyDraftStore = { getByThread: async () => [] };
    const soon = Date.now() + 100_000; // age 100s < 600s grace
    const { zombies } = await collectZombies(store, emptyDraftStore, 'default-user', soon);
    assert.equal(zombies.length, 0, 'grace 内不误判（liveness_pending）');
  });

  it('collectZombies: running 有 fresh draft → 非 zombie（心跳仍在）', async () => {
    const store = new RedisInvocationRecordStore(redis);
    const created = await store.create({
      threadId: 'thr-y',
      userId: 'default-user',
      targetCats: ['sonnet'],
      intent: 'execute',
      idempotencyKey: 'idem-3',
    });
    await store.update(created.invocationId, { status: 'running' });
    const future = Date.now() + 700_000;
    const freshDraftStore = {
      getByThread: async () => [
        {
          invocationId: created.invocationId,
          userId: 'default-user',
          threadId: 'thr-y',
          catId: 'sonnet',
          content: '',
          updatedAt: future - 100_000,
        },
      ],
    };
    const { zombies } = await collectZombies(store, freshDraftStore, 'default-user', future);
    assert.equal(zombies.length, 0, 'fresh draft = 心跳仍在 → 非 zombie');
  });

  it('collectZombies: failed invocation 也作为死球返回', async () => {
    const store = new RedisInvocationRecordStore(redis);
    const created = await store.create({
      threadId: 'thr-failed',
      userId: 'default-user',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'idem-failed',
    });
    await store.update(created.invocationId, { status: 'failed', error: 'spend-limit' });
    const emptyDraftStore = { getByThread: async () => [] };
    const { zombies, runningCount, runningZombieCount } = await collectZombies(
      store,
      emptyDraftStore,
      'default-user',
      Date.now(),
    );
    assert.equal(runningCount, 0);
    assert.equal(runningZombieCount, 0);
    assert.equal(zombies.length, 1);
    assert.equal(zombies[0].detail, 'spend-limit');
  });
});
