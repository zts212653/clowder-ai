/**
 * K-1 / F288 — Redis store implementations (plan Task 8)
 * Mirrors the memory-impl assertion matrix against real Redis.
 * Runs only under the isolated Redis runner (pnpm --filter @cat-cafe/api test:redis);
 * skipped in the default suite. Unique keyPrefix — no wildcard cleanup (per LL in
 * ball-custody-ingest-redis.test.js).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const TEST_KEY_PREFIX = `f288-plugmsg-test-${process.pid}:`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Plugin messaging Redis stores', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let connected = false;
  let RedisLedgerStore;
  let RedisHandleStore;
  let RedisEventLogStore;
  let RedisCursorStore;
  let RedisAppendLock;
  let RedisMessageStore;

  let seq = 0;
  const nextId = (prefix) => `${prefix}-${Date.now()}-${(seq += 1)}`;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'PluginMessagingRedis');
    ({ RedisLedgerStore, RedisHandleStore, RedisEventLogStore, RedisCursorStore, RedisAppendLock } = await import(
      '../dist/domains/messaging/stores/redis.js'
    ));
    ({ RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'));
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: TEST_KEY_PREFIX });
    await redis.ping();
    connected = true;
  });

  after(async () => {
    if (connected) await redis.quit();
  });

  function publishInput(threadId, messageId) {
    return {
      eventId: `ev-${messageId}`,
      type: 'message.publish',
      envelope: {
        messageId,
        revision: 1,
        threadId,
        actor: { kind: 'plugin', id: 'inst-a' },
        audience: { kind: 'public' },
        occurredAt: '2026-07-15T00:00:00.000Z',
        payload: {
          provenance: { origin: { kind: 'plugin', instanceId: 'inst-a' }, epistemicStatus: 'inference' },
          elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'x' } }],
        },
      },
    };
  }

  describe('RedisLedgerStore (§4a)', () => {
    it('unclaimed → new; concurrent → inflight; settle → settled with same receipt', async () => {
      const store = new RedisLedgerStore(redis);
      const key = nextId('ledger');
      const claim = await store.claim(key, 60_000);
      assert.equal(claim.status, 'new');
      assert.deepEqual(await store.claim(key, 60_000), { status: 'inflight' });
      await store.settle(key, claim.claimToken, { messageId: 'm-1', revision: 1 }, 60_000);
      const settled = await store.claim(key, 60_000);
      assert.equal(settled.status, 'settled');
      assert.deepEqual(settled.receipt, { messageId: 'm-1', revision: 1 });
    });

    it('settle keeps the first receipt (sticky)', async () => {
      const store = new RedisLedgerStore(redis);
      const key = nextId('ledger');
      const claim = await store.claim(key, 60_000);
      await store.settle(key, claim.claimToken, { messageId: 'first' }, 60_000);
      await store.settle(key, claim.claimToken, { messageId: 'second' }, 60_000);
      assert.deepEqual((await store.claim(key, 60_000)).receipt, { messageId: 'first' });
    });

    it('release returns inflight to unclaimed but never erases settled', async () => {
      const store = new RedisLedgerStore(redis);
      const key = nextId('ledger');
      const initial = await store.claim(key, 60_000);
      await store.release(key, initial.claimToken);
      const retry = await store.claim(key, 60_000);
      assert.equal(retry.status, 'new');
      await store.settle(key, retry.claimToken, { messageId: 'm' }, 60_000);
      await store.release(key, retry.claimToken);
      assert.equal((await store.claim(key, 60_000)).status, 'settled');
    });

    it('claim TTL expiry frees a crashed claim (PX semantics)', async () => {
      const store = new RedisLedgerStore(redis);
      const key = nextId('ledger');
      await store.claim(key, 80);
      await sleep(140);
      assert.equal((await store.claim(key, 60_000)).status, 'new');
    });

    it('expired claimant cannot release or settle a successor claim', async () => {
      const store = new RedisLedgerStore(redis);
      const key = nextId('ledger');
      const stale = await store.claim(key, 80);
      await sleep(140);
      const successor = await store.claim(key, 60_000);
      await store.release(key, stale.claimToken);
      assert.equal((await store.claim(key, 60_000)).status, 'inflight');
      await store.settle(key, stale.claimToken, { messageId: 'stale' }, 60_000);
      assert.equal((await store.claim(key, 60_000)).status, 'inflight');
      await store.settle(key, successor.claimToken, { messageId: 'winner' }, 60_000);
      assert.deepEqual((await store.claim(key, 60_000)).receipt, { messageId: 'winner' });
    });
  });

  describe('RedisEventLogStore (INV-3, D-3)', () => {
    it('assigns monotonic per-thread sequences; threads independent', async () => {
      const store = new RedisEventLogStore(redis);
      const t1 = nextId('thread');
      const t2 = nextId('thread');
      const r1 = await store.append(t1, 'k1', publishInput(t1, 'm1'), 100);
      const r2 = await store.append(t1, 'k2', publishInput(t1, 'm2'), 100);
      const o1 = await store.append(t2, 'k1', publishInput(t2, 'm1'), 100);
      assert.deepEqual([r1.sequence, r2.sequence, o1.sequence], [1, 2, 1]);
      const events = await store.readAfter(t1, 0, 10);
      assert.deepEqual(
        events.map((e) => e.sequence),
        [1, 2],
      );
      assert.equal(events[0].envelope.messageId, 'm1');
    });

    it('same eventKey dedupes to original sequence within window', async () => {
      const store = new RedisEventLogStore(redis);
      const t = nextId('thread');
      const first = await store.append(t, 'pub:m1:1', publishInput(t, 'm1'), 100);
      const retry = await store.append(t, 'pub:m1:1', publishInput(t, 'm1'), 100);
      assert.deepEqual([retry.deduped, retry.sequence], [true, first.sequence]);
      assert.equal((await store.readAfter(t, 0, 10)).length, 1);
    });

    it('trim drops oldest, floor rises, head keeps counting; trimmed key re-appends fresh', async () => {
      const store = new RedisEventLogStore(redis);
      const t = nextId('thread');
      await store.append(t, 'kX', publishInput(t, 'mX'), 3);
      for (let i = 1; i <= 4; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await store.append(t, `k${i}`, publishInput(t, `m${i}`), 3);
      }
      assert.equal(await store.headSequence(t), 5);
      assert.equal(await store.minSequence(t), 3);
      const again = await store.append(t, 'kX', publishInput(t, 'mX'), 3);
      assert.deepEqual([again.deduped, again.sequence], [false, 6]);
    });

    it('eventKey containing | is stored and trimmed safely', async () => {
      const store = new RedisEventLogStore(redis);
      const t = nextId('thread');
      const weird = 'append:m1:op|with|pipes';
      const first = await store.append(t, weird, publishInput(t, 'm1'), 100);
      const retry = await store.append(t, weird, publishInput(t, 'm1'), 100);
      assert.deepEqual([retry.deduped, retry.sequence], [true, first.sequence]);
    });

    it('empty thread: floor null, head 0', async () => {
      const store = new RedisEventLogStore(redis);
      const t = nextId('thread');
      assert.equal(await store.minSequence(t), null);
      assert.equal(await store.headSequence(t), 0);
    });
  });

  describe('RedisHandleStore + RedisCursorStore (§4c cascade)', () => {
    it('handle roundtrip + idempotent revoke', async () => {
      const store = new RedisHandleStore(redis);
      const handleId = nextId('th_handle');
      await store.put({
        handleId,
        kind: 'thread_handle',
        pluginInstanceId: 'inst-a',
        threadId: 'thread-1',
        userId: 'user-1',
        scope: { canSend: true, canSubscribe: true },
        issuedAt: 1,
      });
      const loaded = await store.get(handleId);
      assert.equal(loaded.threadId, 'thread-1');
      assert.equal(loaded.revokedAt, undefined);
      assert.equal(await store.revoke(handleId, 42), true);
      assert.equal((await store.get(handleId)).revokedAt, 42);
      assert.equal(await store.revoke(handleId, 99), true);
      assert.equal((await store.get(handleId)).revokedAt, 42, 'first revocation timestamp sticks');
      assert.equal(await store.revoke(nextId('missing'), 1), false);
    });

    it('subscription roundtrip, monotonic advances, findByHandle, revoke cascade', async () => {
      const store = new RedisCursorStore(redis);
      const handleId = nextId('th_handle');
      const subscriptionId = nextId('sub');
      await store.put({
        subscriptionId,
        pluginInstanceId: 'inst-a',
        handleId,
        threadId: 'thread-1',
        ackedSequence: 5,
        lastDeliveredSequence: 5,
      });

      const found = await store.findByHandle('inst-a', handleId);
      assert.equal(found.subscriptionId, subscriptionId);
      assert.equal(await store.findByHandle('inst-b', handleId), null);

      await store.advanceAck('inst-a', subscriptionId, 0); // must not regress below subscribe watermark
      assert.equal((await store.get('inst-a', subscriptionId)).ackedSequence, 5);
      await store.advanceAck('inst-a', subscriptionId, 9);
      await store.advanceAck('inst-a', subscriptionId, 7); // regress attempt
      await store.advanceDelivered('inst-a', subscriptionId, 12);
      const loaded = await store.get('inst-a', subscriptionId);
      assert.equal(loaded.ackedSequence, 9, 'ack is monotonic max');
      assert.equal(loaded.lastDeliveredSequence, 12);

      const revoked = await store.revokeByHandle(handleId, 77);
      assert.equal(revoked, 1);
      assert.ok((await store.get('inst-a', subscriptionId)).revokedAt);
      assert.equal(await store.findByHandle('inst-a', handleId), null, 'live lookup excludes revoked');
    });

    it('atomically revokes a subscription added at the cascade linearization point', async () => {
      const rawStore = new RedisCursorStore(redis);
      const handleId = nextId('th_revoke_race');
      const first = {
        subscriptionId: nextId('sub-before-revoke'),
        pluginInstanceId: 'inst-a',
        handleId,
        threadId: 'thread-1',
        ackedSequence: 0,
        lastDeliveredSequence: 0,
      };
      const concurrent = {
        ...first,
        subscriptionId: nextId('sub-during-revoke'),
        pluginInstanceId: 'inst-b',
      };
      await rawStore.put(first);

      let injected = false;
      const injectConcurrentSubscription = async () => {
        if (injected) return;
        injected = true;
        await rawStore.put(concurrent);
      };
      const racingRedis = new Proxy(redis, {
        get(target, property) {
          if (property === 'smembers') {
            return async (...args) => {
              const members = await target.smembers(...args);
              await injectConcurrentSubscription();
              return members;
            };
          }
          if (property === 'eval') {
            return async (script, ...args) => {
              if (script.includes("redis.call('SMEMBERS', KEYS[1])")) {
                await injectConcurrentSubscription();
              }
              return target.eval(script, ...args);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const racingStore = new RedisCursorStore(racingRedis);

      assert.equal(await racingStore.revokeByHandle(handleId, 77), 2);
      assert.equal(injected, true);
      assert.equal((await rawStore.get('inst-a', first.subscriptionId)).revokedAt, 77);
      assert.equal((await rawStore.get('inst-b', concurrent.subscriptionId)).revokedAt, 77);
    });

    it('replaces an indexed revoked subscription like the memory store', async () => {
      const store = new RedisCursorStore(redis);
      const handleId = nextId('th_resubscribe');
      const first = {
        subscriptionId: nextId('sub-revoked'),
        pluginInstanceId: 'inst-a',
        handleId,
        threadId: 'thread-1',
        ackedSequence: 0,
        lastDeliveredSequence: 0,
      };
      const replacement = { ...first, subscriptionId: nextId('sub-replacement') };
      await store.put(first);
      assert.equal(await store.revokeByHandle(handleId, 77), 1);

      const winner = await store.createOrGet(replacement);
      assert.equal(winner.subscriptionId, replacement.subscriptionId);
      assert.equal(winner.revokedAt, undefined);
      assert.equal((await store.findByHandle('inst-a', handleId)).subscriptionId, replacement.subscriptionId);
    });

    it('parallel createOrGet calls atomically converge on one subscription', async () => {
      const store = new RedisCursorStore(redis);
      const handleId = nextId('th_parallel');
      const records = Array.from({ length: 12 }, (_, index) => ({
        subscriptionId: nextId(`sub-${index}`),
        pluginInstanceId: 'inst-a',
        handleId,
        threadId: 'thread-1',
        ackedSequence: 7,
        lastDeliveredSequence: 7,
      }));
      const winners = await Promise.all(records.map((record) => store.createOrGet(record)));
      assert.equal(new Set(winners.map((record) => record.subscriptionId)).size, 1);
      assert.equal((await store.findByHandle('inst-a', handleId)).subscriptionId, winners[0].subscriptionId);
    });
  });

  describe('RedisAppendLock (§4d)', () => {
    it('acquire/contend/release/TTL-expiry', async () => {
      const lock = new RedisAppendLock(redis);
      const messageId = nextId('msg');
      const firstToken = await lock.acquire(messageId, 60_000);
      assert.equal(typeof firstToken.token, 'string');
      assert.equal(await lock.acquire(messageId, 60_000), null);
      await lock.release(messageId, firstToken);
      assert.equal(typeof (await lock.acquire(messageId, 80)).token, 'string');
      await sleep(140);
      assert.equal(typeof (await lock.acquire(messageId, 60_000)).token, 'string', 'expired lock is acquirable');
    });

    it('release only frees own token (stale holder cannot release the new lock)', async () => {
      const lockA = new RedisAppendLock(redis);
      const lockB = new RedisAppendLock(redis);
      const messageId = nextId('msg');
      const staleToken = await lockA.acquire(messageId, 60);
      assert.equal(typeof staleToken.token, 'string');
      await sleep(120); // A's lock expired
      const liveToken = await lockB.acquire(messageId, 60_000);
      assert.equal(typeof liveToken.token, 'string');
      await lockA.release(messageId, staleToken); // stale release must not free B's lock
      assert.equal(await lockA.acquire(messageId, 60_000), null, "B's lock survives A's stale release");
      await lockB.release(messageId, liveToken);
    });
  });

  describe('RedisMessageStore plugin payload isolation', () => {
    it('concurrent host and plugin updates preserve payload arrays and host metadata', async () => {
      const store = new RedisMessageStore(redis);
      const message = await store.append({
        userId: nextId('user'),
        catId: null,
        content: 'plugin message',
        mentions: [],
        timestamp: Date.now(),
        threadId: nextId('thread'),
        extra: {
          rich: { v: 1, blocks: [] },
          pluginMessage: {
            instanceId: 'inst-a',
            revision: 1,
            provenance: { origin: { kind: 'plugin', instanceId: 'inst-a' }, epistemicStatus: 'inference' },
            elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'x' } }],
            appendOps: [],
          },
        },
      });
      const pluginMessage = {
        ...message.extra.pluginMessage,
        revision: 2,
        elements: [
          ...message.extra.pluginMessage.elements,
          { elementId: 'el-2', kind: 'text', payload: { text: 'appended' }, epistemicStatus: 'inference' },
        ],
        appendOps: [{ operationId: 'op-1', elementIds: ['el-2'], baseRevision: 1 }],
      };
      await Promise.all([
        store.updateExtra(message.id, { isExplicitPost: true }),
        store.updatePluginMessage(message.id, pluginMessage, 1),
      ]);
      const loaded = await store.getById(message.id);
      assert.equal(loaded.extra.isExplicitPost, true);
      assert.deepEqual(loaded.extra.pluginMessage, pluginMessage);
      assert.deepEqual(loaded.extra.rich, { v: 1, blocks: [] });

      const [rawHostExtra, rawPluginMessage] = await redis.hmget(`msg:${message.id}`, 'extra', 'pluginMessage');
      assert.equal(JSON.parse(rawHostExtra).pluginMessage, undefined, 'host extra does not duplicate plugin payload');
      assert.deepEqual(JSON.parse(rawPluginMessage), pluginMessage, 'independent field preserves empty arrays');
    });

    it('hard delete wipes the independent plugin payload', async () => {
      const store = new RedisMessageStore(redis);
      const message = await store.append({
        userId: nextId('user'),
        catId: null,
        content: 'sensitive plugin message',
        mentions: [],
        timestamp: Date.now(),
        threadId: nextId('thread'),
        extra: {
          pluginMessage: {
            instanceId: 'inst-a',
            revision: 1,
            provenance: { origin: { kind: 'plugin', instanceId: 'inst-a' }, epistemicStatus: 'inference' },
            elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'secret' } }],
            appendOps: [],
          },
        },
      });

      const tombstone = await store.hardDelete(message.id, 'user-1');
      assert.equal(tombstone._tombstone, true);
      assert.equal(tombstone.extra, undefined);
      assert.equal(await redis.hget(`msg:${message.id}`, 'pluginMessage'), '');
    });
  });
});
