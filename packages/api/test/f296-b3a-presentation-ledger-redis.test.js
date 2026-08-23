// F296 B3a hard gate 4: the presentation ledger must be shared and persistent.
//
// AC-B6 promises "same subject + revision + epoch is not repeated". A
// process-local Map cannot keep that promise: a second API instance has never
// heard of the first instance's deliveries, and a restart forgets its own. The
// AC would then be a claim about one process wearing the clothes of a global
// guarantee.
//
// Every test below uses TWO store instances against one Redis to stand in for
// two API processes / a restart. If the store were still in-memory, "instance B
// sees it" fails — that is the mutation proof.
//
// Iron Rule #5 (LL-048): delivered records are recoverable state -> TTL=0. The
// reservation's expiry is a FIELD checked in Lua, never a Redis TTL, so no
// user-facing record can silently evaporate.
//
// Test Redis only: port 6398, never the 6399 sanctuary.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Redis from 'ioredis';

const TEST_PREFIX = `test:presentation-ledger:${Date.now()}:`;
const SANCTUARY_PORT = '6399';
const DEV_TEST_REDIS_URL = 'redis://localhost:6398';

/** Never let an ambient sanctuary URL become the test target. */
function resolveTestRedisUrl(envUrl) {
  if (!envUrl) return DEV_TEST_REDIS_URL;
  try {
    if (new URL(envUrl).port === SANCTUARY_PORT) return DEV_TEST_REDIS_URL;
  } catch {
    return DEV_TEST_REDIS_URL;
  }
  return envUrl;
}

describe('F296 B3a gate 4: RedisPresentationLedgerStore', () => {
  /** @type {import('ioredis').default} */
  let redis;
  let makeLedger;
  let mintDeliveryReceipt;
  let mapToPresentation;
  let epochStore;
  let RedisPresentationLedgerStore;
  let PresentationLedger;
  let DEFAULT_RESERVATION_TTL_MS;
  let available = false;

  const SCOPE = { scopeKey: 'user-1::opus5::thread-1', contextEpoch: 3 };
  const INVALIDATOR = { owner: 'task-store', ref: 'task-42' };

  before(async () => {
    // Iron Rule #1. A developer shell legitimately has REDIS_URL=...:6399 (the
    // sanctuary) exported, and the isolated-redis harness legitimately overrides
    // it with its own port. Inheriting the env blindly is what would point a
    // test at the sanctuary, so the sanctuary is filtered out here rather than
    // trusted to be absent.
    const redisUrl = resolveTestRedisUrl(process.env.REDIS_URL);
    assert.equal(redisUrl.includes('6399'), false, 'refusing to run against the 6399 sanctuary');
    redis = new Redis(redisUrl, { keyPrefix: TEST_PREFIX, lazyConnect: true, retryStrategy: () => null });
    try {
      await redis.connect();
    } catch {
      redis.disconnect();
      return; // Redis unavailable -> skip
    }
    ({ RedisPresentationLedgerStore } = await import(
      '../dist/domains/cats/services/stores/redis/RedisPresentationLedgerStore.js'
    ));
    const { RedisContextEpochStore } = await import(
      '../dist/domains/cats/services/stores/redis/RedisContextEpochStore.js'
    );
    epochStore = new RedisContextEpochStore(redis);
    ({ PresentationLedger, DEFAULT_RESERVATION_TTL_MS } = await import(
      '../dist/domains/cats/services/session/PresentationLedger.js'
    ));
    ({ mintDeliveryReceipt } = await import('../dist/domains/cats/services/session/delivery-receipt.js'));
    ({ mapToPresentation } = await import('../dist/domains/cats/services/session/context-presentation.js'));

    // Two independent store objects over one Redis == two API instances.
    makeLedger = (clock) => new PresentationLedger(new RedisPresentationLedgerStore(redis), { now: () => clock.nowMs });
    assert.equal(
      await epochStore.compareAndPut(
        {
          scopeKey: SCOPE.scopeKey,
          contextEpoch: SCOPE.contextEpoch,
          contextMode: 'cold',
          lastTransitionRef: 'test:seed',
          consumedCompactionEventIds: [],
          version: 1,
          updatedAt: 1,
        },
        0,
      ),
      true,
    );
    available = true;
  });

  after(async () => {
    if (redis?.status === 'ready') {
      const keys = await redis.keys(`${TEST_PREFIX}*`);
      if (keys.length) {
        const pipeline = redis.multi();
        for (const key of keys) {
          pipeline.del(key.startsWith(TEST_PREFIX) ? key.slice(TEST_PREFIX.length) : key);
        }
        await pipeline.exec();
      }
      await redis.quit();
    }
  });

  let subjectCounter = 0;
  /** Fresh subject per test so cases cannot leak into each other. */
  function claim(overrides = {}) {
    return mapToPresentation({
      subjectKey: `subject-${subjectCounter}`,
      asOf: { kind: 'version', value: 'rev-1' },
      sourceTier: 'T1',
      invalidator: INVALIDATOR,
      requested: 'state',
      ...overrides,
    });
  }
  function nextSubject() {
    subjectCounter += 1;
  }
  function receipt(promptGenerationId) {
    return mintDeliveryReceipt({
      promptGenerationId,
      providerReceivedAt: 1_700_000_000_000,
      providerAdapterId: 'codex/exec_json',
    });
  }

  it('a delivery recorded by one instance is visible to another', async (t) => {
    if (!available) return t.skip('redis unavailable');
    nextSubject();
    const clock = { nowMs: 1_000_000 };
    const instanceA = makeLedger(clock);
    const instanceB = makeLedger(clock);

    const reserved = await instanceA.reserve(claim(), SCOPE, { promptGenerationId: 'gen-1' });
    assert.equal(reserved.admitted, true);
    assert.equal((await instanceA.commit(reserved.reservation, receipt('gen-1'))).committed, true);

    const onB = await instanceB.reserve(claim(), SCOPE, { promptGenerationId: 'gen-2' });
    assert.equal(onB.admitted, false);
    assert.equal(onB.reason, 'already_delivered_this_epoch');
  });

  it('a reservation held by one instance blocks the other', async (t) => {
    if (!available) return t.skip('redis unavailable');
    nextSubject();
    const clock = { nowMs: 1_000_000 };
    const instanceA = makeLedger(clock);
    const instanceB = makeLedger(clock);

    assert.equal((await instanceA.reserve(claim(), SCOPE, { promptGenerationId: 'gen-1' })).admitted, true);
    const onB = await instanceB.reserve(claim(), SCOPE, { promptGenerationId: 'gen-2' });
    assert.equal(onB.admitted, false);
    assert.equal(onB.reason, 'reserved_by_concurrent_prompt');
  });

  it('concurrent reservations across instances admit exactly one', async (t) => {
    if (!available) return t.skip('redis unavailable');
    nextSubject();
    const clock = { nowMs: 1_000_000 };
    const ledgers = Array.from({ length: 8 }, () => makeLedger(clock));

    // Real concurrency against one Redis: only an atomic (Lua) reserve survives.
    const outcomes = await Promise.all(
      ledgers.map((ledger, index) => ledger.reserve(claim(), SCOPE, { promptGenerationId: `gen-${index}` })),
    );
    assert.equal(outcomes.filter((outcome) => outcome.admitted).length, 1);
  });

  it('an instance that never saw the reservation can reclaim it after expiry', async (t) => {
    if (!available) return t.skip('redis unavailable');
    nextSubject();
    const clock = { nowMs: 1_000_000 };
    const crashed = makeLedger(clock);
    const survivor = makeLedger(clock);

    assert.equal((await crashed.reserve(claim(), SCOPE, { promptGenerationId: 'gen-1' })).admitted, true);
    // ...instance "crashed" dies here without releasing.
    clock.nowMs += DEFAULT_RESERVATION_TTL_MS + 1;

    assert.equal((await survivor.reserve(claim(), SCOPE, { promptGenerationId: 'gen-2' })).admitted, true);
  });

  it('delivered records are persistent: TTL=0, no expiry set', async (t) => {
    if (!available) return t.skip('redis unavailable');
    nextSubject();
    const clock = { nowMs: 1_000_000 };
    const ledger = makeLedger(clock);
    const reserved = await ledger.reserve(claim(), SCOPE, { promptGenerationId: 'gen-1' });
    await ledger.commit(reserved.reservation, receipt('gen-1'));

    const keys = await redis.keys(`${TEST_PREFIX}presentation-ledger:*`);
    assert.ok(keys.length > 0, 'expected at least one ledger key');
    for (const key of keys) {
      const unprefixed = key.startsWith(TEST_PREFIX) ? key.slice(TEST_PREFIX.length) : key;
      // -1 == persistent. Anything >= 0 means user-recoverable state would vanish.
      assert.equal(await redis.ttl(unprefixed), -1, `key ${unprefixed} must be persistent`);
    }
  });

  it('stored records stay content-free', async (t) => {
    if (!available) return t.skip('redis unavailable');
    nextSubject();
    const clock = { nowMs: 1_000_000 };
    const ledger = makeLedger(clock);
    const reserved = await ledger.reserve(claim(), SCOPE, { promptGenerationId: 'gen-1' });
    await ledger.commit(reserved.reservation, receipt('gen-1'));

    const keys = await redis.keys(`${TEST_PREFIX}presentation-ledger:*`);
    for (const key of keys) {
      const unprefixed = key.startsWith(TEST_PREFIX) ? key.slice(TEST_PREFIX.length) : key;
      const dumped = JSON.stringify(await redis.hgetall(unprefixed));
      for (const forbidden of ['propose', 'defer', 'abstain', 'canonical', 'snippet']) {
        assert.equal(dumped.includes(forbidden), false, `ledger leaked ${forbidden}`);
      }
    }
  });

  it('a different epoch is a different generation, across instances', async (t) => {
    if (!available) return t.skip('redis unavailable');
    nextSubject();
    const clock = { nowMs: 1_000_000 };
    const instanceA = makeLedger(clock);
    const instanceB = makeLedger(clock);

    const reserved = await instanceA.reserve(claim(), SCOPE, { promptGenerationId: 'gen-1' });
    await instanceA.commit(reserved.reservation, receipt('gen-1'));

    const nextEpoch = { ...SCOPE, contextEpoch: SCOPE.contextEpoch + 1 };
    assert.equal(
      await epochStore.compareAndPut(
        {
          scopeKey: SCOPE.scopeKey,
          contextEpoch: nextEpoch.contextEpoch,
          contextMode: 'cold',
          lastTransitionRef: 'test:advance',
          consumedCompactionEventIds: [],
          version: 2,
          updatedAt: 2,
        },
        1,
      ),
      true,
    );
    assert.equal((await instanceB.reserve(claim(), nextEpoch, { promptGenerationId: 'gen-2' })).admitted, true);
  });
});
