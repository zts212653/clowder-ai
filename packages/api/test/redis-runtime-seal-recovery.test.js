import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { RedisRuntimeSessionStore } from '../dist/domains/cats/services/runtime-session/RedisRuntimeSessionStore.js';
import { RuntimeSessionKeys } from '../dist/domains/cats/services/stores/redis-keys/runtime-session-keys.js';
import { auditRecoveryRedis } from './helpers/recovery-store-audit.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';
import { runtimeSealMetadata } from './helpers/runtime-seal-recovery-fixture.js';

const isolated = { skip: redisIsolationSkipReason(process.env.REDIS_URL) };
async function fixture(body) {
  assertRedisIsolationOrThrow(process.env.REDIS_URL, '1843 runtime seal recovery');
  const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `seal-${randomUUID()}:` });
  try {
    await body(redis, new RedisRuntimeSessionStore(redis));
  } finally {
    await redis.quit();
  }
}

test(
  'runtime seal disposition, original metadata and retry budget survive old writers, cold reads and index rebuild',
  isolated,
  async () => {
    await fixture(async (redis, store) => {
      const record = await store.upsert(runtimeSealMetadata());
      const before = JSON.parse(await redis.get(RuntimeSessionKeys.detail(record.sessionId)));
      await store.initializeSealRecovery();
      assert.equal(await store.parkSealRecovery(record, 3000), true);
      const after = JSON.parse(await redis.get(RuntimeSessionKeys.detail(record.sessionId)));
      const { recoveryDisposition, recoveryReasonCode, recoveryDisposedAt, ...businessLifecycle } = after.lifecycle;
      assert.deepEqual({ ...after, lifecycle: businessLifecycle }, before);
      assert.equal(recoveryDisposition, 'needs_attention');
      assert.equal(recoveryReasonCode, 'seal_retry_exhausted');
      assert.equal(recoveryDisposedAt, 3000);
      await store.upsert({ ...record, lifecycle: { ...record.lifecycle, retryCount: 0, lastObservedAt: 4000 } });
      const restarted = new RedisRuntimeSessionStore(redis);
      await restarted.initializeSealRecovery(true);
      const retained = await restarted.getBySessionId(record.sessionId);
      assert.equal(retained.lifecycle.state, 'runtime_seal_pending');
      assert.equal(retained.lifecycle.retryCount, 5);
      assert.equal(retained.lifecycle.recoveryDisposition, 'needs_attention');
      assert.deepEqual(await restarted.listSealRecoveryCandidates(), []);
      assert.equal(
        (await restarted.listByLifecycleState('runtime_seal_pending')).length,
        1,
        'automatic queue exit is not business completion',
      );
    });
  },
);

test('fixed runtime-seal work reads stay bounded after tenfold settled history', isolated, async () => {
  for (const history of [100, 1000])
    await fixture(async (redis, store) => {
      const writes = redis.pipeline();
      for (let n = 0; n <= history; n++) {
        const record = runtimeSealMetadata(`history-${n}`);
        record.lifecycle.retryCount = 0;
        if (n) record.lifecycle.state = 'sealed';
        writes.set(RuntimeSessionKeys.detail(record.sessionId), JSON.stringify(record));
        writes.zadd(
          RuntimeSessionKeys.byLifecycleState(record.lifecycle.state),
          record.lifecycle.lastObservedAt,
          record.sessionId,
        );
      }
      for (const [error] of await writes.exec()) assert.equal(error, null);
      await store.initializeSealRecovery();
      const audit = await auditRecoveryRedis(redis);
      try {
        assert.equal((await store.listSealRecoveryCandidates(1)).length, 1);
        await audit.flush();
        audit.assertIndexed();
        assert.ok(audit.reads.filter((r) => r.command === 'mget').every((r) => r.args.length <= 1));
      } finally {
        audit.stop();
      }
    });
});

test(
  'malformed runtime metadata is retained once without blocking a healthy record or reviving after rebuild',
  isolated,
  async () => {
    await fixture(async (redis, store) => {
      const good = await store.upsert(runtimeSealMetadata('healthy'));
      const raw = '{broken sidecar';
      await redis.set(RuntimeSessionKeys.detail('malformed'), raw);
      await redis.zadd(RuntimeSessionKeys.byLifecycleState('runtime_seal_pending'), 0, 'malformed');
      await store.initializeSealRecovery();
      assert.deepEqual(
        (await store.listSealRecoveryCandidates()).map((r) => r.sessionId),
        [good.sessionId],
      );
      const retained = await redis.get(RuntimeSessionKeys.detail('malformed'));
      assert.equal(JSON.parse(retained)._sealRecoveryCorruption, raw);
      await store.initializeSealRecovery(true);
      assert.equal(await redis.get(RuntimeSessionKeys.detail('malformed')), retained);
      assert.equal((await store.listSealRecoveryCandidates()).length, 1);
    });
  },
);

test('a corrupt derived seal index cannot partially write an original sidecar', isolated, async () => {
  await fixture(async (redis, store) => {
    const record = runtimeSealMetadata('wrong-index');
    await redis.set(RuntimeSessionKeys.sealRecovery(), 'wrong-type');
    await assert.rejects(store.upsert(record), /runtime_seal_index_wrong_type/);
    assert.equal(await redis.get(RuntimeSessionKeys.detail(record.sessionId)), null);
    assert.equal(await redis.get(RuntimeSessionKeys.byRuntime(record.runtime, record.runtimeSessionId)), null);
  });
});
