/**
 * F257 V1 — DeviationEventLog tests.
 *
 * Semantics single source of truth: F257 redesign doc §3.1 (schema union +
 * DeviationEventLog 存储规格) + T-C §3.6 (incidentKey / 幂等 / Lua 原子).
 * 有 Redis → 测全量；无 Redis → 只跑纯函数 describe（与 projection 测试同模式）。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const OWNER = 'owner-f257-dev';

const model = await import('../dist/infrastructure/harness-eval/deviation/deviation-event.js');
const { manualIncidentKey, conditionIncidentKey, validateDeviationEvent, V1_REGISTRY_VERSION } = model;

const anchorA = { kind: 'thread_message', messageId: 'msg-a' };

function attribution(overrides = {}) {
  return {
    objectiveId: 'obj-routing-delivery',
    unitRefs: [{ unitType: 'segment', unitId: 'S1' }],
    weight: 0.8,
    ...overrides,
  };
}

function manualEvent(overrides = {}) {
  const attributions = overrides.attributions ?? [attribution()];
  const sourceAnchor = overrides.sourceAnchor ?? anchorA;
  const subjectCatId = overrides.subjectCatId ?? 'cat-subject';
  const ownerUserId = overrides.ownerUserId ?? OWNER;
  return {
    kind: 'manual_observation',
    eventId: `dev-${randomUUID()}`,
    timestamp: Date.now(),
    registryVersion: V1_REGISTRY_VERSION,
    incidentKey: manualIncidentKey(ownerUserId, sourceAnchor, subjectCatId, attributions),
    ownerUserId,
    attributions,
    anchors: { threadId: 'th-dev', messageId: sourceAnchor.messageId },
    source: 'peer',
    subjectCatId,
    note: 'observed drift in relay handoff',
    sourceAnchor,
    recordedBy: 'cat-recorder',
    ...overrides,
  };
}

function conditionEvent(overrides = {}) {
  const ownerUserId = overrides.ownerUserId ?? OWNER;
  return {
    kind: 'condition_hit',
    eventId: `dev-${randomUUID()}`,
    timestamp: Date.now(),
    registryVersion: 'cond-registry-v0',
    incidentKey: conditionIncidentKey(ownerUserId, 'signature_missing', 'fact:msg-1'),
    ownerUserId,
    attributions: [attribution({ weight: 1.0 })],
    anchors: { threadId: 'th-dev', messageId: 'msg-1' },
    conditionId: 'signature_missing',
    sourceFactRef: 'fact:msg-1',
    recordedBy: 'system',
    subjectCatId: 'cat-subject',
    ...overrides,
  };
}

describe('F257 V1: deviation-event pure model (T-C incidentKey + §3.1 validation)', () => {
  it('manualIncidentKey is stable across attribution/unitRef ordering (服务端排序防换序绕过)', () => {
    const attrs = [
      attribution({ objectiveId: 'obj-b', unitRefs: [{ unitType: 'segment', unitId: 'S2' }] }),
      attribution({
        objectiveId: 'obj-a',
        unitRefs: [
          { unitType: 'segment', unitId: 'S9' },
          { unitType: 'segment', unitId: 'S1' },
        ],
      }),
    ];
    const swapped = [{ ...attrs[1], unitRefs: [...attrs[1].unitRefs].reverse() }, attrs[0]];
    assert.equal(
      manualIncidentKey(OWNER, anchorA, 'cat-s', attrs),
      manualIncidentKey(OWNER, anchorA, 'cat-s', swapped),
    );
  });

  it('manualIncidentKey: weight is NOT identity; unitId/owner/anchor/subject ARE (T-C v2.3)', () => {
    const base = manualIncidentKey(OWNER, anchorA, 'cat-s', [attribution({ weight: 0.3 })]);
    assert.equal(base, manualIncidentKey(OWNER, anchorA, 'cat-s', [attribution({ weight: 0.9 })]));
    assert.notEqual(
      base,
      manualIncidentKey(OWNER, anchorA, 'cat-s', [attribution({ unitRefs: [{ unitType: 'segment', unitId: 'D1' }] })]),
    );
    assert.notEqual(base, manualIncidentKey('owner-other', anchorA, 'cat-s', [attribution()]));
    assert.notEqual(
      base,
      manualIncidentKey(OWNER, { kind: 'thread_message', messageId: 'msg-b' }, 'cat-s', [attribution()]),
    );
    assert.notEqual(base, manualIncidentKey(OWNER, anchorA, 'cat-other', [attribution()]));
  });

  it('conditionIncidentKey is owner-namespaced (§3.1 v1.8)', () => {
    assert.notEqual(
      conditionIncidentKey(OWNER, 'cond-1', 'fact:1'),
      conditionIncidentKey('owner-other', 'cond-1', 'fact:1'),
    );
  });

  it('validateDeviationEvent: manual weights ∈ (0,1], objective 不重复, unitType V1 仅 segment', () => {
    assert.deepEqual(validateDeviationEvent(manualEvent()), []);
    assert.ok(validateDeviationEvent(manualEvent({ attributions: [attribution({ weight: 0 })] })).length > 0);
    assert.ok(validateDeviationEvent(manualEvent({ attributions: [attribution({ weight: 1.2 })] })).length > 0);
    assert.ok(
      validateDeviationEvent(manualEvent({ attributions: [attribution(), attribution({ weight: 0.4 })] })).length > 0,
      'duplicate objectiveId must be rejected',
    );
    assert.ok(
      validateDeviationEvent(
        manualEvent({ attributions: [attribution({ unitRefs: [{ unitType: 'skill', unitId: 'k1' }] })] }),
      ).length > 0,
      'unitType outside V1 adapter registry must be rejected',
    );
    assert.ok(validateDeviationEvent(manualEvent({ attributions: [] })).length > 0);
    assert.ok(validateDeviationEvent(manualEvent({ attributions: [attribution({ unitRefs: [] })] })).length > 0);
    assert.ok(validateDeviationEvent(manualEvent({ note: '' })).length > 0);
    assert.ok(validateDeviationEvent(manualEvent({ subjectCatId: '' })).length > 0);
  });

  it('validateDeviationEvent: exact 支强制单条 weight=1.0 (§3.1)', () => {
    assert.deepEqual(validateDeviationEvent(conditionEvent()), []);
    assert.ok(validateDeviationEvent(conditionEvent({ attributions: [attribution({ weight: 0.9 })] })).length > 0);
    assert.ok(
      validateDeviationEvent(
        conditionEvent({
          attributions: [attribution({ weight: 1.0 }), attribution({ objectiveId: 'obj-x', weight: 1.0 })],
        }),
      ).length > 0,
      'exact branch must have exactly one attribution',
    );
    assert.ok(
      validateDeviationEvent(conditionEvent({ recordedBy: 'cat-x' })).length > 0,
      'condition_hit recordedBy must be system',
    );
  });
});

describe(
  'F257 V1: RedisDeviationEventLog (§3.1 存储规格 + T-C Lua 原子)',
  { skip: redisIsolationSkipReason(REDIS_URL) },
  () => {
    let log;
    let DeviationKeys;
    let redis;
    let connected = false;
    // owner-scoped cleanup —— 两个 deviation 测试文件可并发跑，不互删数据
    const CLEANUP_PATTERNS = [`deviation:*:${OWNER}`, 'deviation:*:owner-other'];

    before(async () => {
      assertRedisIsolationOrThrow(REDIS_URL, 'RedisDeviationEventLog');
      const mod = await import('../dist/infrastructure/harness-eval/deviation/DeviationEventLog.js');
      const redisModule = await import('@cat-cafe/shared/utils');
      redis = redisModule.createRedisClient({ url: REDIS_URL });
      try {
        await redis.ping();
        connected = true;
      } catch {
        await redis.quit().catch(() => {});
        return;
      }
      log = new mod.RedisDeviationEventLog(redis);
      DeviationKeys = mod.DeviationKeys;
    });

    after(async () => {
      if (redis && connected) {
        await cleanupPrefixedRedisKeys(redis, CLEANUP_PATTERNS);
        await redis.quit();
      }
    });

    beforeEach(async (t) => {
      if (!connected) return t.skip('Redis not connected');
      await cleanupPrefixedRedisKeys(redis, CLEANUP_PATTERNS);
    });

    it('append → query roundtrip; TTL=0 on every key (存储规格 / 铁律#5)', async () => {
      const evt = manualEvent();
      const res = await log.append(evt);
      assert.deepEqual(res, { outcome: 'appended', eventId: evt.eventId });

      const q = await log.query({ ownerUserId: OWNER });
      assert.equal(q.events.length, 1);
      assert.deepEqual(q.events[0], evt);
      assert.equal(q.nextCursor, null);
      assert.deepEqual(q.missingBodies, []);

      // pttl: -1 = key 存在且无 TTL；-2 = 不存在（一并断言存在性）
      for (const key of [DeviationKeys.events(OWNER), DeviationKeys.index(OWNER), DeviationKeys.claims(OWNER)]) {
        assert.equal(await redis.pttl(key), -1, `key ${key} must exist with no TTL`);
      }
    });

    it('same incidentKey → incident_claimed, ledger unchanged (T-C 原子 claim)', async () => {
      const first = manualEvent();
      assert.equal((await log.append(first)).outcome, 'appended');
      // 同 incident 重报：新 eventId、weight 变化都不绕过 claim（weight 不在 identity 里）
      const dup = manualEvent({ attributions: [attribution({ weight: 0.2 })] });
      const res = await log.append(dup);
      assert.deepEqual(res, { outcome: 'incident_claimed', eventId: first.eventId });
      assert.equal(await log.countInWindow(OWNER, 0, Date.now() + 1000), 1);
    });

    it('different unitRef → different incident, both land (T-C v2.3 canonical attributions)', async () => {
      assert.equal((await log.append(manualEvent())).outcome, 'appended');
      const other = manualEvent({
        attributions: [attribution({ unitRefs: [{ unitType: 'segment', unitId: 'D1' }] })],
      });
      assert.equal((await log.append(other)).outcome, 'appended');
      assert.equal(await log.countInWindow(OWNER, 0, Date.now() + 1000), 2);
    });

    it('idempotencyKey replay returns original eventId without double append (T-C 幂等)', async () => {
      const evt = manualEvent();
      const first = await log.append(evt, { idempotencyKey: 'cat-recorder:th-dev:retry-1' });
      assert.equal(first.outcome, 'appended');
      const retry = await log.append(manualEvent(), { idempotencyKey: 'cat-recorder:th-dev:retry-1' });
      assert.deepEqual(retry, { outcome: 'idempotent_replay', eventId: evt.eventId });
      assert.equal(await log.countInWindow(OWNER, 0, Date.now() + 1000), 1);
      assert.equal(await redis.pttl(DeviationKeys.idempotency(OWNER)), -1, 'idem key must exist with no TTL');
    });

    it('invalid event throws (await-append §4.5-2 — 写失败显式可见，不 fail-open)', async () => {
      await assert.rejects(() => log.append(manualEvent({ attributions: [attribution({ weight: 0 })] })), /weight/);
      assert.equal(await log.countInWindow(OWNER, 0, Date.now() + 1000), 0);
    });

    it('condition_hit branch is storable (union support; V1 只是无 writer)', async () => {
      const evt = conditionEvent();
      assert.equal((await log.append(evt)).outcome, 'appended');
      const q = await log.query({ ownerUserId: OWNER });
      assert.deepEqual(q.events[0], evt);
    });

    it('pagination: cursor walk covers all events, no dup/loss, incl. same-timestamp ties (不沿用 200 静默截断)', async () => {
      const base = Date.now();
      const ids = [];
      for (let i = 0; i < 25; i += 1) {
        // 前 8 条共享同一 timestamp，逼出 cursor tie-break 路径
        const ts = i < 8 ? base : base + i;
        const evt = manualEvent({
          timestamp: ts,
          sourceAnchor: { kind: 'thread_message', messageId: `msg-${i}` },
          anchors: { threadId: 'th-dev', messageId: `msg-${i}` },
        });
        ids.push(evt.eventId);
        assert.equal((await log.append(evt)).outcome, 'appended');
      }

      const seen = [];
      let cursor;
      for (let page = 0; page < 10; page += 1) {
        const q = await log.query({ ownerUserId: OWNER, limit: 10, ...(cursor ? { cursor } : {}) });
        seen.push(...q.events.map((e) => e.eventId));
        if (!q.nextCursor) break;
        cursor = q.nextCursor;
      }
      assert.equal(seen.length, 25);
      assert.equal(new Set(seen).size, 25);
      assert.deepEqual(new Set(seen), new Set(ids));
    });

    it('query window filter + countInWindow agree (完整聚合口径)', async () => {
      const base = Date.now();
      for (let i = 0; i < 6; i += 1) {
        await log.append(
          manualEvent({
            timestamp: base + i * 100,
            sourceAnchor: { kind: 'thread_message', messageId: `msg-w${i}` },
          }),
        );
      }
      const q = await log.query({ ownerUserId: OWNER, fromMs: base + 100, toMs: base + 400 });
      assert.equal(q.events.length, 4);
      assert.equal(await log.countInWindow(OWNER, base + 100, base + 400), 4);
    });

    it('owner isolation: owner B sees nothing of owner A (ownerUserId 进索引与查询授权)', async () => {
      await log.append(manualEvent());
      const q = await log.query({ ownerUserId: 'owner-other' });
      assert.equal(q.events.length, 0);
      assert.equal(await log.countInWindow('owner-other', 0, Date.now() + 1000), 0);
    });
  },
);
