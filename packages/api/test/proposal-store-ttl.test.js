// @ts-check
/**
 * F128 P0 contract — RedisProposalStore must NOT auto-expire proposal hashes.
 *
 * Iron law #5 (LL-048): user-visible/recoverable state defaults to persistent
 * (TTL=0); TTL is only opt-in. Proposal hashes carry approval-card UI state +
 * approval audit lineage, and the zset indices (proposals:user/pending/thread)
 * would otherwise dangle when the hash expires. This unit test pins the
 * contract by intercepting `multi()` and asserting whether `expire()` was
 * issued — no live Redis required, so it runs in the public CI test job.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { RedisProposalStore } = await import('../dist/domains/cats/services/stores/redis/RedisProposalStore.js');

/**
 * Capture all pipeline ops for a given multi() call.
 * RedisProposalStore.create() only uses: hset, expire, zadd, exec.
 */
function createMockRedis() {
  /** @type {Array<{ ops: Array<[string, ...unknown[]]> }>} */
  const pipelines = [];

  function makePipeline() {
    /** @type {Array<[string, ...unknown[]]>} */
    const ops = [];
    const pipeline = {
      hset(...args) {
        ops.push(['hset', ...args]);
        return pipeline;
      },
      expire(...args) {
        ops.push(['expire', ...args]);
        return pipeline;
      },
      zadd(...args) {
        ops.push(['zadd', ...args]);
        return pipeline;
      },
      async exec() {
        return [];
      },
    };
    pipelines.push({ ops });
    return pipeline;
  }

  return {
    pipelines,
    multi: makePipeline,
    pipeline: makePipeline,
  };
}

function baseInput(overrides = {}) {
  return {
    sourceThreadId: 'thread_src',
    sourceInvocationId: 'inv_1',
    sourceCatId: 'opus',
    title: 'TTL contract',
    reason: 'pin LL-048 / iron law #5',
    parentThreadId: 'thread_src',
    preferredCats: ['codex'],
    projectPath: '/tmp/ttl-test',
    createdBy: 'alice',
    ...overrides,
  };
}

describe('RedisProposalStore — TTL contract (iron law #5 / LL-048)', () => {
  it('default constructor: create() does NOT issue EXPIRE on the proposal hash', async () => {
    const redis = createMockRedis();
    const store = new RedisProposalStore(/** @type {any} */ (redis));
    await store.create(baseInput());
    assert.equal(redis.pipelines.length, 1, 'create should use exactly one multi() pipeline');
    const expireOps = redis.pipelines[0].ops.filter((op) => op[0] === 'expire');
    assert.equal(
      expireOps.length,
      0,
      'default create must NOT call expire — user-visible state is persistent by default',
    );
  });

  it('explicit ttlSeconds > 0 opts in: EXPIRE is issued on the proposal hash', async () => {
    const redis = createMockRedis();
    const store = new RedisProposalStore(/** @type {any} */ (redis), { ttlSeconds: 60 });
    const created = await store.create(baseInput({ createdBy: 'bob' }));
    const expireOps = redis.pipelines[0].ops.filter((op) => op[0] === 'expire');
    assert.equal(expireOps.length, 1, 'explicit positive ttlSeconds must call expire exactly once');
    // op shape: ['expire', key, seconds]
    assert.equal(expireOps[0][1], `proposal:${created.proposalId}`);
    assert.equal(expireOps[0][2], 60);
  });

  it('ttlSeconds = 0 is treated as no-ttl (defensive against accidental zeroing)', async () => {
    const redis = createMockRedis();
    const store = new RedisProposalStore(/** @type {any} */ (redis), { ttlSeconds: 0 });
    await store.create(baseInput({ createdBy: 'carol' }));
    const expireOps = redis.pipelines[0].ops.filter((op) => op[0] === 'expire');
    assert.equal(expireOps.length, 0, 'ttlSeconds=0 must be treated as no-ttl');
  });

  it('negative ttlSeconds is treated as no-ttl', async () => {
    const redis = createMockRedis();
    const store = new RedisProposalStore(/** @type {any} */ (redis), { ttlSeconds: -1 });
    await store.create(baseInput({ createdBy: 'dave' }));
    const expireOps = redis.pipelines[0].ops.filter((op) => op[0] === 'expire');
    assert.equal(expireOps.length, 0, 'negative ttlSeconds must be treated as no-ttl');
  });

  it('NaN ttlSeconds is treated as no-ttl', async () => {
    const redis = createMockRedis();
    const store = new RedisProposalStore(/** @type {any} */ (redis), { ttlSeconds: Number.NaN });
    await store.create(baseInput({ createdBy: 'erin' }));
    const expireOps = redis.pipelines[0].ops.filter((op) => op[0] === 'expire');
    assert.equal(expireOps.length, 0, 'NaN ttlSeconds must be treated as no-ttl');
  });
});

// F128 Phase Y — reportingMode persistence (serialize → hydrate round-trip).
// Pins the Redis-backed contract that InMemory store tests can't catch
// (feedback_inmemory_store_tests_miss_redis_behavior): serialize HSET, hydrate
// read-back, and back-compat for pre-Phase-Y hashes missing the field.
function createStoreMockRedis() {
  /** @type {Map<string, Record<string, string>>} */
  const hashes = new Map();
  function makePipeline() {
    const pipeline = {
      hset(key, ...args) {
        const h = hashes.get(key) ?? {};
        for (let i = 0; i < args.length; i += 2) h[String(args[i])] = String(args[i + 1]);
        hashes.set(key, h);
        return pipeline;
      },
      expire() {
        return pipeline;
      },
      zadd() {
        return pipeline;
      },
      async exec() {
        return [];
      },
    };
    return pipeline;
  }
  return {
    hashes,
    multi: makePipeline,
    pipeline: makePipeline,
    async hgetall(key) {
      return hashes.get(key) ?? {};
    },
  };
}

describe('RedisProposalStore — reportingMode persistence (F128 Phase Y)', () => {
  it('create with reportingMode → HSET writes it → get() hydrates it back', async () => {
    const redis = createStoreMockRedis();
    const store = new RedisProposalStore(/** @type {any} */ (redis));
    const created = await store.create(baseInput({ reportingMode: 'final-only' }));
    const hash = redis.hashes.get(`proposal:${created.proposalId}`);
    assert.equal(hash?.reportingMode, 'final-only', 'serialize must HSET reportingMode');
    const got = await store.get(created.proposalId);
    assert.equal(got?.reportingMode, 'final-only', 'hydrate must read reportingMode back');
  });

  it('create WITHOUT reportingMode → field absent → get() hydrates undefined (default final-only via enrich)', async () => {
    const redis = createStoreMockRedis();
    const store = new RedisProposalStore(/** @type {any} */ (redis));
    const created = await store.create(baseInput());
    const hash = redis.hashes.get(`proposal:${created.proposalId}`);
    assert.equal(hash?.reportingMode, undefined, 'no reportingMode → field not written (back-compat)');
    const got = await store.get(created.proposalId);
    assert.equal(
      got?.reportingMode,
      undefined,
      'missing field hydrates to undefined (enrich applies default final-only)',
    );
  });

  it('legacy hash without reportingMode → get() returns undefined (pre-Phase-Y back-compat)', async () => {
    const redis = createStoreMockRedis();
    const store = new RedisProposalStore(/** @type {any} */ (redis));
    redis.hashes.set('proposal:legacy_1', {
      proposalId: 'legacy_1',
      status: 'pending',
      sourceThreadId: 'thread_src',
      sourceInvocationId: 'inv_0',
      sourceCatId: 'opus',
      title: 'legacy',
      reason: 'pre Phase Y',
      parentThreadId: 'thread_src',
      preferredCats: '[]',
      projectPath: '/tmp',
      createdBy: 'alice',
      createdAt: '1700000000000',
    });
    const got = await store.get('legacy_1');
    assert.equal(
      got?.reportingMode,
      undefined,
      'legacy proposal has no reportingMode → undefined → default final-only',
    );
  });

  it('all 4 reporting modes round-trip through serialize → hydrate', async () => {
    for (const mode of /** @type {const} */ (['none', 'final-only', 'state-transitions', 'blocking-ack'])) {
      const redis = createStoreMockRedis();
      const store = new RedisProposalStore(/** @type {any} */ (redis));
      const created = await store.create(baseInput({ reportingMode: mode, createdBy: `u_${mode}` }));
      const got = await store.get(created.proposalId);
      assert.equal(got?.reportingMode, mode, `${mode} must round-trip`);
    }
  });
});
