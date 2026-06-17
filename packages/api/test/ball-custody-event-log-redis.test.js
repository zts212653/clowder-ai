/**
 * BallCustodyEventLog Redis tests（F233 Phase B — B1）
 * 照 redis-community-event-log.test.js。Redis-backed（in-memory 掩盖索引行为，feedback_inmemory）。
 * INV-1 append-only / INV-3 幂等去重 / read fromSequence / listSubjects / cross-subject 隔离。
 * 有 Redis → 真实验证；无 Redis → skip。
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

function makeEvent(overrides = {}) {
  return {
    sourceEventId: 'route:msg-1',
    subjectKey: 'ball:task:t1',
    kind: 'task.blocked',
    classification: 'state-changing',
    payload: {},
    at: 1000,
    ...overrides,
  };
}

describe('BallCustodyEventLog (Redis)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisBallCustodyEventLog;
  let createRedisClient;
  let redis;
  let log;
  let connected = false;

  const KEY_PATTERNS = ['ballcustody:events:*'];

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'BallCustodyEventLog');
    const mod = await import('../dist/domains/ball-custody/BallCustodyEventLog.js');
    RedisBallCustodyEventLog = mod.RedisBallCustodyEventLog;
    createRedisClient = (await import('@cat-cafe/shared/utils')).createRedisClient;
    redis = createRedisClient(REDIS_URL);
    await redis.ping();
    connected = true;
    log = new RedisBallCustodyEventLog(redis);
  });

  after(async () => {
    if (connected) await redis.quit();
  });

  beforeEach(async () => {
    await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
  });

  describe('append — 幂等（INV-1/3）', () => {
    it('新事件 → appended=true + numeric sequence', async () => {
      const r = await log.append(makeEvent());
      assert.strictEqual(r.appended, true);
      assert.strictEqual(typeof r.sequence, 'number');
    });

    it('同 sourceEventId 二次 append → appended=false', async () => {
      const e = makeEvent();
      await log.append(e);
      assert.strictEqual((await log.append(e)).appended, false);
    });

    it('重复 append 不加第二条（INV-3）', async () => {
      const e = makeEvent();
      await log.append(e);
      await log.append(e);
      assert.strictEqual((await log.read('ball:task:t1')).length, 1);
    });

    it('不同 sourceEventId → 各自独立', async () => {
      await log.append(makeEvent({ sourceEventId: 'a1', at: 1000 }));
      await log.append(makeEvent({ sourceEventId: 'a2', at: 2000, kind: 'task.done' }));
      assert.strictEqual((await log.read('ball:task:t1')).length, 2);
    });
  });

  describe('append — ordering（INV-1 replay 序）', () => {
    it('保持插入序', async () => {
      const events = [
        makeEvent({ sourceEventId: 'e1', kind: 'task.blocked', at: 1000 }),
        makeEvent({ sourceEventId: 'e2', kind: 'ball.wake_sent', at: 2000 }),
        makeEvent({ sourceEventId: 'e3', kind: 'task.done', at: 3000 }),
      ];
      for (const e of events) await log.append(e);
      const read = await log.read('ball:task:t1');
      assert.deepStrictEqual(
        read.map((e) => e.kind),
        ['task.blocked', 'ball.wake_sent', 'task.done'],
      );
    });

    it('sequence 单调递增', async () => {
      const r1 = await log.append(makeEvent({ sourceEventId: 'x1' }));
      const r2 = await log.append(makeEvent({ sourceEventId: 'x2', kind: 'task.done' }));
      assert.ok(r2.sequence > r1.sequence, 'sequence must increase');
    });
  });

  describe('read — fromSequence', () => {
    it('fromSequence 1 跳过首条', async () => {
      await log.append(makeEvent({ sourceEventId: 'b1', at: 1 }));
      await log.append(makeEvent({ sourceEventId: 'b2', at: 2, kind: 'ball.wake_sent' }));
      await log.append(makeEvent({ sourceEventId: 'b3', at: 3, kind: 'task.done' }));
      const tail = await log.read('ball:task:t1', 1);
      assert.strictEqual(tail.length, 2);
      assert.strictEqual(tail[0].kind, 'ball.wake_sent');
    });

    it('未知 subjectKey → 空数组', async () => {
      assert.deepStrictEqual(await log.read('ball:task:nope'), []);
    });
  });

  describe('listSubjects', () => {
    it('无事件 → 空数组', async () => {
      assert.deepStrictEqual(await log.listSubjects(), []);
    });

    it('列出所有有事件的 subject', async () => {
      await log.append(makeEvent({ subjectKey: 'ball:task:a', sourceEventId: 'sa' }));
      await log.append(makeEvent({ subjectKey: 'ball:thread:b', sourceEventId: 'sb' }));
      const subjects = await log.listSubjects();
      assert.ok(subjects.includes('ball:task:a'));
      assert.ok(subjects.includes('ball:thread:b'));
      assert.strictEqual(subjects.length, 2);
    });
  });

  describe('cross-subject 隔离', () => {
    it('不同 subject 独立存储', async () => {
      await log.append(makeEvent({ subjectKey: 'ball:task:x', sourceEventId: 'x1' }));
      await log.append(makeEvent({ subjectKey: 'ball:task:y', sourceEventId: 'y1', kind: 'task.done' }));
      assert.strictEqual((await log.read('ball:task:x')).length, 1);
      assert.strictEqual((await log.read('ball:task:y'))[0].kind, 'task.done');
    });
  });
});
