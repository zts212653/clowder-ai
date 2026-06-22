/**
 * F208 Phase D: RedisDossierObservationStore integration test.
 *
 * Verifies Redis persistence (Iron Rule #5: TTL=0 user state).
 * Uses test Redis infrastructure (port 6398, never 6399).
 *
 * Covers P0 review finding: production store must persist observations
 * across restarts — in-memory store is insufficient.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Redis from 'ioredis';

const TEST_PREFIX = `test:dossier-obs:${Date.now()}:`;

describe('RedisDossierObservationStore', () => {
  /** @type {import('ioredis').default} */
  let redis;
  /** @type {import('../src/domains/cats/services/stores/redis/RedisDossierObservationStore.js').RedisDossierObservationStore} */
  let store;

  before(async () => {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6398';
    redis = new Redis(redisUrl, { keyPrefix: TEST_PREFIX, lazyConnect: true });
    try {
      await redis.connect();
    } catch {
      // Skip if Redis unavailable in CI
      return;
    }
    const { RedisDossierObservationStore } = await import(
      '../dist/domains/cats/services/stores/redis/RedisDossierObservationStore.js'
    );
    store = new RedisDossierObservationStore(redis);
  });

  after(async () => {
    if (redis?.status === 'ready') {
      // Clean up test keys
      const keys = await redis.keys(`${TEST_PREFIX}*`);
      if (keys.length) {
        // Strip prefix since pipeline uses keyPrefix
        const pipeline = redis.multi();
        for (const key of keys) {
          const logicalKey = key.startsWith(TEST_PREFIX) ? key.slice(TEST_PREFIX.length) : key;
          pipeline.del(logicalKey);
        }
        await pipeline.exec();
      }
      await redis.quit();
    }
  });

  it('add persists observation to Redis hash + sorted set index', async () => {
    if (!store) return; // skip if no Redis
    const obs = await store.add({ catId: 'opus', content: 'Strong at architecture', author: 'you' });
    assert.ok(obs.id.startsWith('obs_'));
    assert.equal(obs.catId, 'opus');
    assert.equal(obs.content, 'Strong at architecture');
    assert.equal(obs.provenance.type, 'cvo');
    assert.equal(obs.provenance.author, 'you');
    assert.ok(obs.createdAt > 0);

    // Verify persisted in Redis hash
    const hash = await redis.hgetall(`dossier-obs:${obs.id}`);
    assert.equal(hash.catId, 'opus');
    assert.equal(hash.content, 'Strong at architecture');
    assert.equal(hash.provenanceAuthor, 'you');

    // Verify in sorted set index
    const members = await redis.zrange(`dossier-obs:cat:opus`, 0, -1);
    assert.ok(members.includes(obs.id));
  });

  it('list returns observations newest first', async () => {
    if (!store) return;
    const obs1 = await store.add({ catId: 'codex', content: 'First observation', author: 'you' });
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 5));
    const obs2 = await store.add({ catId: 'codex', content: 'Second observation', author: 'you' });

    const list = await store.list('codex');
    assert.ok(list.length >= 2);
    // Newest first
    const idx1 = list.findIndex((o) => o.id === obs1.id);
    const idx2 = list.findIndex((o) => o.id === obs2.id);
    assert.ok(idx2 < idx1, 'newest observation should come first');
  });

  it('list respects limit parameter', async () => {
    if (!store) return;
    await store.add({ catId: 'limited-cat', content: 'A', author: 'you' });
    await store.add({ catId: 'limited-cat', content: 'B', author: 'you' });
    await store.add({ catId: 'limited-cat', content: 'C', author: 'you' });

    const list = await store.list('limited-cat', 2);
    assert.equal(list.length, 2);
  });

  it('listAll groups observations by catId', async () => {
    if (!store) return;
    await store.add({ catId: 'cat-a', content: 'Obs for A', author: 'you' });
    await store.add({ catId: 'cat-b', content: 'Obs for B', author: 'you' });

    const all = await store.listAll();
    assert.ok(all['cat-a']?.length >= 1);
    assert.ok(all['cat-b']?.length >= 1);
  });

  it('get returns observation by id', async () => {
    if (!store) return;
    const obs = await store.add({ catId: 'opus', content: 'Retrievable', author: 'you' });
    const found = await store.get(obs.id);
    assert.ok(found);
    assert.equal(found.id, obs.id);
    assert.equal(found.content, 'Retrievable');
  });

  it('get returns null for non-existent id', async () => {
    if (!store) return;
    const found = await store.get('obs_nonexistent');
    assert.equal(found, null);
  });

  it('delete removes from both hash and index', async () => {
    if (!store) return;
    const obs = await store.add({ catId: 'delete-test', content: 'To delete', author: 'you' });
    const deleted = await store.delete(obs.id);
    assert.equal(deleted, true);

    // Verify gone from hash
    const found = await store.get(obs.id);
    assert.equal(found, null);

    // Verify gone from index
    const members = await redis.zrange(`dossier-obs:cat:delete-test`, 0, -1);
    assert.ok(!members.includes(obs.id));
  });

  it('delete returns false for non-existent id', async () => {
    if (!store) return;
    const deleted = await store.delete('obs_nonexistent');
    assert.equal(deleted, false);
  });

  it('observations have no TTL (Iron Rule #5: user state persists)', async () => {
    if (!store) return;
    const obs = await store.add({ catId: 'ttl-test', content: 'Must persist', author: 'you' });
    const ttl = await redis.ttl(`dossier-obs:${obs.id}`);
    // -1 means no expiry, -2 means key doesn't exist
    assert.equal(ttl, -1, 'observation hash must have no TTL (TTL=0 = persist forever)');
  });
});
