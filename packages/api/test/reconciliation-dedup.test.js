import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/** In-memory Redis mock with GET/SET/DEL */
function createMockRedis() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value, exToken, ttl) {
      store.set(key, value);
      return 'OK';
    },
    async del(...keys) {
      let count = 0;
      for (const k of keys) {
        if (store.delete(k)) count++;
      }
      return count;
    },
  };
}

describe('ReconciliationDedup', () => {
  let redis;
  let dedup;

  beforeEach(async () => {
    const { ReconciliationDedup } = await import(
      '../dist/infrastructure/connectors/github-repo-event/ReconciliationDedup.js'
    );
    redis = createMockRedis();
    dedup = new ReconciliationDedup(redis);
  });

  it('returns false for a new item', async () => {
    const result = await dedup.isNotified('zts212653/cat-cafe', 'pr', 42);
    assert.equal(result, false);
  });

  it('returns true after markNotified', async () => {
    await dedup.markNotified('zts212653/cat-cafe', 'pr', 42);
    const result = await dedup.isNotified('zts212653/cat-cafe', 'pr', 42);
    assert.equal(result, true);
  });

  it('tracks PRs and Issues independently', async () => {
    await dedup.markNotified('zts212653/cat-cafe', 'pr', 10);
    assert.equal(await dedup.isNotified('zts212653/cat-cafe', 'pr', 10), true);
    assert.equal(await dedup.isNotified('zts212653/cat-cafe', 'issue', 10), false);
  });

  it('tracks repos independently', async () => {
    await dedup.markNotified('zts212653/cat-cafe', 'pr', 5);
    assert.equal(await dedup.isNotified('zts212653/cat-cafe', 'pr', 5), true);
    assert.equal(await dedup.isNotified('zts212653/clowder-ai', 'pr', 5), false);
  });

  it('uses correct key prefix', async () => {
    await dedup.markNotified('zts212653/cat-cafe', 'pr', 99);
    assert.ok(redis.store.has('f141:notified:zts212653/cat-cafe#pr-99'));
  });
});
