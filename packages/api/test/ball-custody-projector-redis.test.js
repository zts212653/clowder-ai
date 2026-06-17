/**
 * F233 Phase B — Projector + ProjectionStore Redis 端到端（B1）
 * 照 redis-community-event-log.test.js。真实 Redis 验 CRUD + apply 持久化 + rebuild 幂等。
 * feedback_inmemory_store_tests_miss_redis_behavior：projection 查询模式过真实 Redis。
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

function ev(kind, { payload = {}, at = 1000, classification, subjectKey = 'ball:task:t1' } = {}) {
  return {
    sourceEventId: `${kind}:${at}`,
    subjectKey,
    kind,
    classification: classification ?? (kind === 'ball.wake_sent' ? 'informational' : 'state-changing'),
    payload,
    at,
  };
}

function makeProjection(overrides = {}) {
  return {
    subjectKey: 'ball:task:s1',
    state: 'active',
    holder: 'opus',
    intent: null,
    resolveMode: null,
    heldUntil: null,
    blockedSinceAt: null,
    lastWakeAt: null,
    lastScanAt: null,
    lastStateChangeAt: 1,
    lastEventAt: 1,
    appliedEventCount: 1,
    lastRejectedEvent: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('BallCustody Projector+Store (Redis 端到端)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisBallCustodyEventLog;
  let RedisBallCustodyProjectionStore;
  let BallCustodyProjector;
  let createRedisClient;
  let redis;
  let log;
  let store;
  let projector;
  let connected = false;

  const KEY_PATTERNS = ['ballcustody:*'];

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'BallCustodyProjector');
    RedisBallCustodyEventLog = (await import('../dist/domains/ball-custody/BallCustodyEventLog.js'))
      .RedisBallCustodyEventLog;
    RedisBallCustodyProjectionStore = (await import('../dist/domains/ball-custody/BallCustodyProjectionStore.js'))
      .RedisBallCustodyProjectionStore;
    BallCustodyProjector = (await import('../dist/domains/ball-custody/BallCustodyProjector.js')).BallCustodyProjector;
    createRedisClient = (await import('@cat-cafe/shared/utils')).createRedisClient;
    redis = createRedisClient(REDIS_URL);
    await redis.ping();
    connected = true;
    log = new RedisBallCustodyEventLog(redis);
    store = new RedisBallCustodyProjectionStore(redis);
    projector = new BallCustodyProjector(log, store);
  });

  after(async () => {
    if (connected) await redis.quit();
  });

  beforeEach(async () => {
    await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
  });

  describe('ProjectionStore CRUD', () => {
    it('save → get 往返一致', async () => {
      const p = makeProjection();
      await store.save(p);
      assert.deepStrictEqual(await store.get('ball:task:s1'), p);
    });

    it('get 未知 subjectKey → null', async () => {
      assert.strictEqual(await store.get('ball:task:nope'), null);
    });

    it('delete 移除 projection + index', async () => {
      await store.save(makeProjection({ subjectKey: 'ball:task:d1' }));
      await store.delete('ball:task:d1');
      assert.strictEqual(await store.get('ball:task:d1'), null);
      assert.ok(!(await store.listSubjectKeys()).includes('ball:task:d1'));
    });

    it('listSubjectKeys 列出所有 projection', async () => {
      await store.save(makeProjection({ subjectKey: 'ball:task:a' }));
      await store.save(makeProjection({ subjectKey: 'ball:thread:b' }));
      const keys = await store.listSubjectKeys();
      assert.ok(keys.includes('ball:task:a'));
      assert.ok(keys.includes('ball:thread:b'));
    });
  });

  describe('Projector apply → Redis projection', () => {
    it('append + apply → projection 持久化到 Redis', async () => {
      const e = ev('task.blocked', { at: 5000 });
      await log.append(e);
      await projector.apply(e);
      const p = await store.get('ball:task:t1');
      assert.strictEqual(p.state, 'blocked');
      assert.strictEqual(p.blockedSinceAt, 5000);
    });
  });

  describe('rebuild 幂等（INV-2 真实 Redis）', () => {
    it('apply 序列 → rebuild(replay) 逐字段相同', async () => {
      const events = [
        ev('ball.handed', { payload: { toCatId: 'opus' }, at: 100 }),
        ev('task.blocked', { at: 200 }),
        ev('ball.wake_sent', { at: 300 }),
        ev('task.unblocked', { at: 400 }),
      ];
      for (const e of events) {
        await log.append(e);
        await projector.apply(e);
      }
      const before = await store.get('ball:task:t1');
      await projector.rebuild('ball:task:t1');
      assert.deepStrictEqual(await store.get('ball:task:t1'), before);
    });
  });
});
