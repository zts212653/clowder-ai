import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { SessionSealer } from '../dist/domains/cats/services/session/SessionSealer.js';
import { RedisSessionChainStore } from '../dist/domains/cats/services/stores/redis/RedisSessionChainStore.js';
import { SessionChainKeys } from '../dist/domains/cats/services/stores/redis-keys/session-chain-keys.js';
import { auditRecoveryRedis } from './helpers/recovery-store-audit.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

test(
  'a sealing read timeout charges the selected source revision before the full record read returns',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, '1843 sealing read timeout');
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `sealing-timeout-${process.pid}:` });
    const store = new RedisSessionChainStore(redis);
    let release;
    let pending;
    try {
      const broken = await store.create({ catId: 'opus', userId: 'owner', threadId: 'broken' });
      const healthy = await store.create({ catId: 'opus', userId: 'owner', threadId: 'healthy' });
      await store.update(broken.id, { status: 'sealing', updatedAt: 1 });
      await store.update(healthy.id, { status: 'sealing', updatedAt: 2 });
      for (let n = 0; n < 4; n++) await store.recordSealingRecoveryFailure(broken.id, 1);
      const get = store.get.bind(store);
      store.get = (id, ...args) => {
        if (id !== broken.id) return get(id, ...args);
        pending = new Promise((resolve) => {
          release = resolve;
        }).then(() => get(id, ...args));
        return pending;
      };
      const sealer = new SessionSealer(store);
      await sealer.reconcileAllStuck();
      assert.equal((await store.getSealingRecoveryFacts(broken.id)).failures, 5);
      assert.equal((await store.getSealingRecoveryFacts(healthy.id)).failures, 0);
      await sealer.reconcileAllStuck();
      assert.equal((await get(healthy.id)).status, 'sealed');
      await store.initializeSealingRecovery(true);
      assert.deepEqual(await store.listSealingSessions(), []);
      assert.equal((await get(broken.id)).status, 'sealing');
    } finally {
      release?.();
      await pending?.catch(() => {});
      await redis.quit();
    }
  },
);

test(
  'session sealing selects its active index after one census; tenfold settled history does not expand periodic reads',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, '1843 session recovery index');
    for (const history of [100, 1000]) {
      const redis = createRedisClient({
        url: process.env.REDIS_URL,
        keyPrefix: `session-due-${process.pid}-${history}:`,
      });
      let audit;
      try {
        const writes = redis.pipeline();
        for (let n = 0; n < history + 1; n++)
          writes.hset(SessionChainKeys.detail(`session-${n}`), {
            id: `session-${n}`,
            status: n === 0 ? 'sealing' : 'sealed',
            updatedAt: '1',
            createdAt: '1',
          });
        for (const [error] of await writes.exec()) assert.equal(error, null);
        const store = new RedisSessionChainStore(redis);
        await store.initializeSealingRecovery?.();
        audit = await auditRecoveryRedis(redis);
        assert.deepEqual(await store.listSealingSessions(), ['session-0']);
        await audit.flush();
        audit.assertIndexed();
        assert.ok(
          audit.reads.filter((r) => r.command === 'hmget').length <= 2,
          'historical session hashes must not be decoded each round',
        );
      } finally {
        audit?.stop();
        await redis.quit();
      }
    }
  },
);

test(
  'all session status writers publish sealing membership atomically; failed recovery stays parked on rebuild',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, '1843 session sealing writers');
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `sealing-writers-${process.pid}:` });
    try {
      const store = new RedisSessionChainStore(redis);
      const input = { catId: 'opus', userId: 'owner', threadId: 'thread' };
      const old = await store.create(input);
      await store.transitionToSealing(old.id, 'test');
      assert.deepEqual(await store.listSealingSessions(), [old.id]);
      assert.deepEqual(await store.listSealingSessions(1, 0), []);
      await store.update(old.id, { status: 'sealed' });
      const active = await store.create(input);
      await store.restoreActiveSession({
        targetSessionId: old.id,
        expectedActiveSessionId: active.id,
        displacedSealReason: 'manual',
      });
      assert.deepEqual(await store.listSealingSessions(), [active.id]);
      const at = (await store.get(active.id)).updatedAt;
      const original = await redis.hgetall(SessionChainKeys.detail(active.id));
      for (let n = 0; n < 5; n++) await store.recordSealingRecoveryFailure(active.id, at);
      assert.deepEqual(await store.listSealingSessions(), []);
      await store.initializeSealingRecovery(true);
      assert.deepEqual(await new RedisSessionChainStore(redis).listSealingSessions(), []);
      const parked = await redis.hgetall(SessionChainKeys.detail(active.id));
      assert.equal(parked._sealingRecoveryDisposition, 'needs_attention');
      for (const [key, value] of Object.entries(original)) assert.equal(parked[key], value);
      // A late failure cannot park a newly restored active session.
      await store.update(active.id, { status: 'sealed' });
      await store.restoreActiveSession({
        targetSessionId: active.id,
        expectedActiveSessionId: old.id,
        displacedSealReason: 'manual',
      });
      await store.recordSealingRecoveryFailure(active.id, at);
      assert.equal((await store.get(active.id)).status, 'active');
      assert.equal(await redis.hget(SessionChainKeys.detail(active.id), '_sealingRecoveryDisposition'), null);
      await redis.del(SessionChainKeys.sealing());
      await redis.set(SessionChainKeys.sealing(), 'invalid derived index');
      await assert.rejects(store.transitionToSealing(active.id, 'test'), /invalid_session_sealing_index/);
      assert.equal((await store.get(active.id)).status, 'active');
      assert.equal(await redis.get(SessionChainKeys.activeOwner('owner', 'opus', 'thread')), active.id);
      await assert.rejects(
        store.update(active.id, { status: 'sealed', cliSessionId: 'new-runtime' }),
        /invalid_session_sealing_index/,
      );
      assert.equal(
        await redis.get(SessionChainKeys.byCli('new-runtime')),
        null,
        'a failed status publication cannot leave a new CLI binding',
      );
      assert.equal((await store.get(active.id)).status, 'active');
    } finally {
      await redis.quit();
    }
  },
);
