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
