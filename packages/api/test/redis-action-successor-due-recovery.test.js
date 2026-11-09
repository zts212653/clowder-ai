import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { ActionSuccessorKeys } from '../dist/domains/ball-custody/action-successor-keys.js';
import { RedisActionSuccessorLeaseStore } from '../dist/domains/ball-custody/RedisActionSuccessorLeaseStore.js';
import { actionRecoveryLease as lease, withActionRecoveryRedis } from './helpers/action-recovery-fixture.js';
import { auditRecoveryRedis } from './helpers/recovery-store-audit.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

test(
  'ActionSuccessor fixed due work does not read its all-history set at either history size',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, '1843 B3 actual selector');
    for (const history of [100, 1000]) {
      const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `b3-due-${process.pid}-${history}:` });
      let audit;
      try {
        const write = redis.pipeline();
        for (let n = 0; n < history + 3; n++) {
          const value = lease(n, n >= 3),
            key = ActionSuccessorKeys.detail(value.leaseId);
          write.set(key, JSON.stringify(value));
          write.set(ActionSuccessorKeys.identity(value), `${redis.options.keyPrefix}${key}`);
          write.sadd(ActionSuccessorKeys.ALL, `${redis.options.keyPrefix}${key}`);
        }
        for (const [error] of await write.exec()) assert.equal(error, null);
        const store = new RedisActionSuccessorLeaseStore(redis);
        await store.initializeRecovery();
        audit = await auditRecoveryRedis(redis);
        assert.equal((await store.listPendingDispatches(2)).length, 2);
        await audit.flush();
        audit.assertIndexed();
        assert.ok(audit.reads.filter(({ command }) => command === 'mget').every(({ args }) => args.length <= 2));
      } finally {
        audit?.stop();
        await redis.quit();
      }
    }
  },
);

const isolated = { skip: redisIsolationSkipReason(process.env.REDIS_URL) };
test(
  'bad census rows retain original bytes once, do not starve valid rows, and stay excluded after rebuild',
  isolated,
  async () => {
    await withActionRecoveryRedis(async ({ redis, store, seed }) => {
      const valid = lease(1, false);
      const malformed = lease(2, false);
      malformed.completionCandidates = { 'codex61-sol': { evidenceRefs: [], candidateRevision: 1, recordedAt: 1 } };
      const raw = JSON.stringify(malformed);
      await seed(malformed);
      await seed(valid);
      await seed(lease(3, true));
      await assert.rejects(store.get(malformed.leaseId), /machine-checkable completion evidence/);
      await store.initializeRecovery();
      assert.deepEqual(
        (await store.listPendingDispatches()).map((x) => x.leaseId),
        [valid.leaseId],
      );
      const key = ActionSuccessorKeys.detail(malformed.leaseId);
      const classified = await redis.get(key);
      assert.equal(JSON.parse(classified)._invalidRaw, raw);
      assert.equal(JSON.parse(classified).disposition, 'needs_attention');
      // Reintroducing a corrupt projection is repaired without nesting or losing the original bytes.
      await redis.zadd(ActionSuccessorKeys.recoveryDue('dispatch'), 0, `${redis.options.keyPrefix}${key}`);
      await store.listPendingDispatches();
      assert.equal(await redis.get(key), classified);
      await store.initializeRecovery(true);
      assert.equal(await redis.get(key), classified);
      assert.deepEqual(
        (await store.listPendingDispatches()).map((x) => x.leaseId),
        [valid.leaseId],
      );
      assert.equal((await store.get('lease-3')).status, 'completed');
      assert.equal(await redis.scard(ActionSuccessorKeys.ALL), 3);
    });
  },
);

test('wrong-typed due or all projection fails before any claim writes', isolated, async () => {
  await withActionRecoveryRedis(async ({ redis, store }) => {
    const record = lease(1, false);
    const input = { ...record, now: 1 };
    for (const badKey of [ActionSuccessorKeys.recoveryDue('task'), ActionSuccessorKeys.ALL]) {
      await redis.set(badKey, 'wrong-type');
      await assert.rejects(store.claim(input), /wrong_type/);
      assert.equal(await store.get(record.leaseId), null);
      assert.equal(await redis.get(ActionSuccessorKeys.identity(record)), null);
      assert.equal(await redis.zcard(ActionSuccessorKeys.recoveryDue('dispatch')), 0);
      await redis.del(badKey);
    }
    const claimed = await store.claim(input);
    assert.equal(claimed.outcome, 'claimed');
    assert.equal(await redis.zcard(ActionSuccessorKeys.recoveryDue('task')), 1);
    assert.equal(Object.hasOwn(claimed.lease, '_recovery'), false);
  });
});

test(
  'recovery-only CAS preserves terminal business JSON, empty arrays and escaped nested fields without repeated growth',
  isolated,
  async () => {
    await withActionRecoveryRedis(async ({ redis, store, seed }) => {
      const original = lease(7, true);
      original.extension = { _recovery: 'business nested field', text: '"},"_recovery":[]' };
      await seed(original);
      await store.initializeRecovery();
      const key = ActionSuccessorKeys.detail(original.leaseId);
      const firstRaw = await redis.get(key);
      const { _recovery, _recoveryRevision, ...business } = JSON.parse(firstRaw);
      assert.deepEqual(business, original);
      assert.ok(Array.isArray((await store.get(original.leaseId)).returnTransitions));
      for (let n = 0; n < 20; n++) {
        const snapshot = await store.recovery.read(original.leaseId, 'task');
        assert.equal(await store.recovery.update(snapshot, 'task', snapshot.fact), true);
      }
      const lastRaw = await redis.get(key);
      const { _recovery: _lastFact, _recoveryRevision: _lastRevision, ...lastBusiness } = JSON.parse(lastRaw);
      assert.deepEqual(lastBusiness, original);
      assert.ok(Math.abs(firstRaw.length - lastRaw.length) < 3, 'only metadata revision digits may grow');
    });
  },
);
