/**
 * CommunityEventLog Redis tests (F168 Phase A — Task 2)
 * 测试 append-only 幂等事件 log 的核心行为：
 * 1. 同 sourceEventId 第二次 append → { appended: false }，log 中只有一条
 * 2. 不同事件 append → 顺序保持，sequence 单调递增
 * 3. read(fromSequence) → 从指定序号起切片
 * 4. listSubjects → 列出所有 subjectKey
 *
 * 有 Redis → 真实 Redis-backed 验证；无 Redis → skip
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
    sourceEventId: 'delivery-abc123',
    subjectKey: 'issue:owner/repo#42',
    kind: 'issue.opened',
    classification: 'state-changing',
    payload: { title: 'Fix the thing' },
    at: 1000,
    ...overrides,
  };
}

describe('CommunityEventLog (Redis)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let CommunityEventLog;
  let createRedisClient;
  let redis;
  let log;
  let connected = false;

  const KEY_PATTERNS = ['community:events:*'];

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'CommunityEventLog');

    const mod = await import('../dist/domains/community/CommunityEventLog.js');
    CommunityEventLog = mod.RedisCommunityEventLog;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient(REDIS_URL);
    await redis.ping();
    connected = true;
    log = new CommunityEventLog(redis);
  });

  after(async () => {
    if (connected) await redis.quit();
  });

  beforeEach(async () => {
    await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
  });

  describe('append — idempotency', () => {
    it('appends a new event and returns appended=true', async () => {
      const event = makeEvent();
      const result = await log.append(event);
      assert.strictEqual(result.appended, true);
      assert.strictEqual(typeof result.sequence, 'number');
    });

    it('second append with same sourceEventId returns appended=false', async () => {
      const event = makeEvent();
      await log.append(event);
      const result2 = await log.append(event);
      assert.strictEqual(result2.appended, false);
    });

    it('duplicate append does not add a second entry to the log', async () => {
      const event = makeEvent();
      await log.append(event);
      await log.append(event);
      const events = await log.read('issue:owner/repo#42');
      assert.strictEqual(events.length, 1);
    });

    it('different sourceEventId appends as separate entries', async () => {
      const e1 = makeEvent({ sourceEventId: 'del-1', at: 1000 });
      const e2 = makeEvent({ sourceEventId: 'del-2', at: 2000, kind: 'issue.closed' });
      await log.append(e1);
      await log.append(e2);
      const events = await log.read('issue:owner/repo#42');
      assert.strictEqual(events.length, 2);
    });
  });

  describe('append — ordering', () => {
    it('preserves insertion order across appends', async () => {
      const events = [
        makeEvent({ sourceEventId: 'e1', kind: 'issue.opened', at: 1000 }),
        makeEvent({ sourceEventId: 'e2', kind: 'case.triaged', at: 2000 }),
        makeEvent({ sourceEventId: 'e3', kind: 'case.routed', at: 3000 }),
      ];
      for (const e of events) await log.append(e);
      const read = await log.read('issue:owner/repo#42');
      assert.deepStrictEqual(
        read.map((e) => e.kind),
        ['issue.opened', 'case.triaged', 'case.routed'],
      );
    });

    it('sequence numbers are monotonically increasing', async () => {
      const r1 = await log.append(makeEvent({ sourceEventId: 'x1' }));
      const r2 = await log.append(makeEvent({ sourceEventId: 'x2', kind: 'issue.closed' }));
      assert.ok(r2.sequence > r1.sequence, 'sequence must increase');
    });
  });

  describe('read — fromSequence', () => {
    it('read from sequence 0 returns all events', async () => {
      await log.append(makeEvent({ sourceEventId: 'a1', at: 1 }));
      await log.append(makeEvent({ sourceEventId: 'a2', at: 2, kind: 'case.triaged' }));
      const events = await log.read('issue:owner/repo#42', 0);
      assert.strictEqual(events.length, 2);
    });

    it('read fromSequence 1 skips the first event', async () => {
      await log.append(makeEvent({ sourceEventId: 'b1', at: 1 }));
      await log.append(makeEvent({ sourceEventId: 'b2', at: 2, kind: 'case.triaged' }));
      await log.append(makeEvent({ sourceEventId: 'b3', at: 3, kind: 'case.routed' }));
      const tail = await log.read('issue:owner/repo#42', 1);
      assert.strictEqual(tail.length, 2);
      assert.strictEqual(tail[0].kind, 'case.triaged');
    });

    it('read on unknown subjectKey returns empty array', async () => {
      const events = await log.read('issue:nobody/nothing#999');
      assert.deepStrictEqual(events, []);
    });
  });

  describe('listSubjects', () => {
    it('returns empty array when no events exist', async () => {
      const subjects = await log.listSubjects();
      assert.deepStrictEqual(subjects, []);
    });

    it('returns all subjects that have at least one event', async () => {
      await log.append(makeEvent({ subjectKey: 'issue:owner/repo#1', sourceEventId: 'i1' }));
      await log.append(makeEvent({ subjectKey: 'pr:owner/repo#2', sourceEventId: 'p1', kind: 'pr.opened' }));
      const subjects = await log.listSubjects();
      assert.ok(subjects.includes('issue:owner/repo#1'));
      assert.ok(subjects.includes('pr:owner/repo#2'));
      assert.strictEqual(subjects.length, 2);
    });
  });

  describe('cross-subject isolation', () => {
    it('events on different subjects are stored independently', async () => {
      await log.append(makeEvent({ subjectKey: 'issue:org/r#10', sourceEventId: 'i10' }));
      await log.append(makeEvent({ subjectKey: 'issue:org/r#20', sourceEventId: 'i20', kind: 'issue.closed' }));
      const events10 = await log.read('issue:org/r#10');
      const events20 = await log.read('issue:org/r#20');
      assert.strictEqual(events10.length, 1);
      assert.strictEqual(events10[0].kind, 'issue.opened');
      assert.strictEqual(events20.length, 1);
      assert.strictEqual(events20[0].kind, 'issue.closed');
    });
  });
});
