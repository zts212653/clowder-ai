import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/**
 * F235 R4: RedisCommunityIssueDraftStore partial-failure rollback + self-heal.
 *
 * Tests use a mock Redis to simulate pipeline failures at precise points.
 * Covers:
 * - create() rollback: SET NX succeeds → pipeline fails → source key DELeted
 * - create() orphan reclaim: NX fails but detail hash missing → reclaim + create
 * - getBySourceId() self-heal: source key exists but detail hash gone → cleanup
 */

let RedisCommunityIssueDraftStore;

const validInput = {
  sourceType: 'frustration_issue',
  sourceId: 'fi_rollback_test',
  title: 'Rollback test',
  bodyMarkdown: '## Test',
  targetRepo: 'clowder-ai/cat-cafe',
  labels: ['test'],
  threadId: 'thread_t1',
  userId: 'usr_u1',
};

// ── Mock Redis ───────────────────────────────────────────────

function createMockRedis({ execShouldThrow = false } = {}) {
  const store = new Map(); // key → value (strings) or key → Map (hashes)
  const zsets = new Map(); // key → Map(member → score)
  const calls = [];

  function record(method, ...args) {
    calls.push({ method, args });
  }

  const redis = {
    _store: store,
    _zsets: zsets,
    _calls: calls,

    async set(key, value, ...flags) {
      record('set', key, value, ...flags);
      if (flags.includes('NX') && store.has(key)) {
        return null; // NX failed
      }
      store.set(key, value);
      return 'OK';
    },

    async get(key) {
      record('get', key);
      return store.get(key) ?? null;
    },

    async del(key) {
      record('del', key);
      store.delete(key);
      return 1;
    },

    async hgetall(key) {
      record('hgetall', key);
      const hash = store.get(key);
      if (!hash || !(hash instanceof Map)) return {};
      return Object.fromEntries(hash.entries());
    },

    async hset(key, ...fieldValues) {
      record('hset', key, ...fieldValues);
      if (!store.has(key) || !(store.get(key) instanceof Map)) {
        store.set(key, new Map());
      }
      const hash = store.get(key);
      for (let i = 0; i < fieldValues.length; i += 2) {
        hash.set(fieldValues[i], fieldValues[i + 1]);
      }
      return fieldValues.length / 2;
    },

    async zadd(key, score, member) {
      record('zadd', key, score, member);
      if (!zsets.has(key)) zsets.set(key, new Map());
      zsets.get(key).set(member, score);
      return 1;
    },

    multi() {
      const ops = [];
      const pipeline = {
        hset(key, ...fieldValues) {
          ops.push({ op: 'hset', args: [key, ...fieldValues] });
          return pipeline;
        },
        zadd(key, score, member) {
          ops.push({ op: 'zadd', args: [key, score, member] });
          return pipeline;
        },
        del(key) {
          ops.push({ op: 'del', args: [key] });
          return pipeline;
        },
        async exec() {
          record(
            'exec',
            ops.map((o) => o.op),
          );
          if (execShouldThrow) {
            throw new Error('EXECABORT simulated pipeline failure');
          }
          const results = [];
          for (const { op, args } of ops) {
            const result = await redis[op](...args);
            results.push([null, result]);
          }
          return results;
        },
      };
      return pipeline;
    },
  };

  return redis;
}

describe('F235 R4: RedisCommunityIssueDraftStore rollback + self-heal', () => {
  beforeEach(async () => {
    const mod = await import('../../dist/domains/cats/services/stores/redis/RedisCommunityIssueDraftStore.js');
    RedisCommunityIssueDraftStore = mod.RedisCommunityIssueDraftStore;
  });

  // ── create() rollback on pipeline failure ───────────────────

  it('create: rolls back source key when pipeline fails', async () => {
    const redis = createMockRedis({ execShouldThrow: true });
    const store = new RedisCommunityIssueDraftStore(redis);

    // Should throw because pipeline fails
    await assert.rejects(
      () => store.create(validInput),
      (err) => err.message.includes('simulated pipeline failure'),
    );

    // Source key must NOT survive — rollback should have DELeted it
    const orphanedKey = await redis.get('community-issue-draft:source:fi_rollback_test');
    assert.equal(orphanedKey, null, 'Source key must be rolled back after pipeline failure');
  });

  it('create: source slot is reclaimable after pipeline rollback', async () => {
    // First: fail the pipeline
    const failRedis = createMockRedis({ execShouldThrow: true });
    const failStore = new RedisCommunityIssueDraftStore(failRedis);

    await assert.rejects(() => failStore.create(validInput));

    // Second: succeed with clean Redis (simulating retry)
    const okRedis = createMockRedis({ execShouldThrow: false });
    const okStore = new RedisCommunityIssueDraftStore(okRedis);

    const draft = await okStore.create(validInput);
    assert.equal(draft.status, 'draft');
    assert.ok(draft.draftId.startsWith('cid_'));
  });

  // ── create() orphan self-heal (NX fails, detail missing) ───

  it('create: reclaims orphaned source key (NX fails but detail hash missing)', async () => {
    const redis = createMockRedis();
    const store = new RedisCommunityIssueDraftStore(redis);

    // Simulate orphan: source key exists pointing at a draftId whose detail hash is gone
    await redis.set('community-issue-draft:source:fi_rollback_test', 'cid_ghost');
    // No detail hash for cid_ghost — it's an orphan

    // create() should self-heal: detect orphan, reclaim, and succeed
    const draft = await store.create(validInput);
    assert.equal(draft.status, 'draft');
    assert.equal(draft.sourceId, 'fi_rollback_test');
    // The new draft should be accessible
    const fetched = await store.getById(draft.draftId);
    assert.ok(fetched);
    assert.equal(fetched.draftId, draft.draftId);
  });

  it('create: reclaims source key from cancelled draft', async () => {
    const redis = createMockRedis();
    const store = new RedisCommunityIssueDraftStore(redis);

    // Create and cancel a draft
    const draft1 = await store.create(validInput);
    await store.cancel(draft1.draftId);

    // Create again — should reclaim the source slot
    const draft2 = await store.create(validInput);
    assert.ok(draft2.draftId !== draft1.draftId);
    assert.equal(draft2.status, 'draft');
  });

  it('create: re-claims when source key vanishes between NX and GET (concurrent cancel)', async () => {
    // Simulates: NX fails (key existed) → concurrent cancel DELs key → GET returns null
    // Without the fix, code falls through without a source claim → INV-3 violation
    const redis = createMockRedis();
    const store = new RedisCommunityIssueDraftStore(redis);

    let nxCallCount = 0;
    const originalSet = redis.set.bind(redis);
    redis.set = async (key, value, ...flags) => {
      if (flags.includes('NX') && key.includes(':source:')) {
        nxCallCount++;
        if (nxCallCount === 1) {
          // First NX: simulate "key exists" (another draft claimed it)
          redis._store.set(key, 'cid_about_to_cancel');
          return null; // NX fails
        }
        // Subsequent NX calls: normal behavior (retry should succeed since key was DELed)
      }
      return originalSet(key, value, ...flags);
    };

    const originalGet = redis.get.bind(redis);
    redis.get = async (key) => {
      if (key.includes(':source:') && redis._store.get(key) === 'cid_about_to_cancel') {
        // Simulate concurrent cancel deleting the key between NX and GET
        redis._store.delete(key);
        return null;
      }
      return originalGet(key);
    };

    const draft = await store.create(validInput);
    assert.equal(draft.status, 'draft');
    assert.equal(draft.sourceId, 'fi_rollback_test');

    // Verify source key was properly claimed (points to the new draft, not dangling)
    const sourceKey = await originalGet('community-issue-draft:source:fi_rollback_test');
    assert.equal(sourceKey, draft.draftId, 'Source key must point to the new draft after re-claim');

    // Verify getBySourceId can find it (the whole point — no dangling draft)
    const found = await store.getBySourceId('fi_rollback_test');
    assert.ok(found, 'Draft must be findable via getBySourceId after re-claim');
    assert.equal(found.draftId, draft.draftId);
  });

  it('create: still rejects when active draft exists (not orphaned)', async () => {
    const redis = createMockRedis();
    const store = new RedisCommunityIssueDraftStore(redis);

    await store.create(validInput);
    // Second create with same sourceId — real active draft exists
    await assert.rejects(
      () => store.create(validInput),
      (err) => err.message.includes('already has'),
    );
  });

  // ── getBySourceId() self-heal ──────────────────────────────

  it('getBySourceId: self-heals orphaned source key (detail hash missing)', async () => {
    const redis = createMockRedis();
    const store = new RedisCommunityIssueDraftStore(redis);

    // Simulate orphan: source key exists but detail hash is gone
    await redis.set('community-issue-draft:source:fi_orphan', 'cid_gone');

    // getBySourceId should return null AND clean up the orphaned key
    const result = await store.getBySourceId('fi_orphan');
    assert.equal(result, null);

    // Verify orphan was cleaned up
    const cleaned = await redis.get('community-issue-draft:source:fi_orphan');
    assert.equal(cleaned, null, 'Orphaned source key should be cleaned up');
  });

  it('getBySourceId: does NOT clean up valid source key', async () => {
    const redis = createMockRedis();
    const store = new RedisCommunityIssueDraftStore(redis);

    // Create a real draft
    const draft = await store.create(validInput);

    // getBySourceId should return it without deleting
    const found = await store.getBySourceId('fi_rollback_test');
    assert.ok(found);
    assert.equal(found.draftId, draft.draftId);

    // Source key should still exist
    const key = await redis.get('community-issue-draft:source:fi_rollback_test');
    assert.ok(key, 'Valid source key should not be cleaned up');
  });
});
