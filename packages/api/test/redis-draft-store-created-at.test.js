import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

class FakePipeline {
  constructor(redis) {
    this.redis = redis;
    this.ops = [];
  }

  hset(key, fieldsOrField, value) {
    this.ops.push(() => this.redis.hset(key, fieldsOrField, value));
    return this;
  }

  hsetnx(key, field, value) {
    this.ops.push(() => this.redis.hsetnx(key, field, value));
    return this;
  }

  sadd(key, value) {
    this.ops.push(() => this.redis.sadd(key, value));
    return this;
  }

  expire(key, seconds) {
    this.ops.push(() => this.redis.expire(key, seconds));
    return this;
  }

  persist(key) {
    this.ops.push(() => this.redis.persist(key));
    return this;
  }

  async exec() {
    const results = [];
    for (const op of this.ops) {
      results.push([null, await op()]);
    }
    return results;
  }
}

class FakeRedis {
  constructor() {
    this.hashes = new Map();
    this.sets = new Map();
    this.expired = [];
    this.ttls = new Map();
  }

  multi() {
    return new FakePipeline(this);
  }

  async hget(key, field) {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hset(key, fieldsOrField, value) {
    const hash = this.hashes.get(key) ?? new Map();
    this.hashes.set(key, hash);
    if (typeof fieldsOrField === 'string') {
      hash.set(fieldsOrField, String(value));
    } else {
      for (const [field, fieldValue] of Object.entries(fieldsOrField)) {
        hash.set(field, String(fieldValue));
      }
    }
    return 1;
  }

  async hsetnx(key, field, value) {
    const hash = this.hashes.get(key) ?? new Map();
    this.hashes.set(key, hash);
    if (hash.has(field)) return 0;
    hash.set(field, String(value));
    return 1;
  }

  async sadd(key, value) {
    const set = this.sets.get(key) ?? new Set();
    this.sets.set(key, set);
    set.add(value);
    return 1;
  }

  async expire(key, seconds) {
    this.expired.push([key, seconds]);
    this.ttls.set(key, seconds);
    return 1;
  }

  async persist(key) {
    return this.ttls.delete(key) ? 1 : 0;
  }
}

describe('RedisDraftStore createdAt migration', () => {
  it('preserves legacy updatedAt as createdAt when upserting a hash without createdAt', async () => {
    const { RedisDraftStore } = await import('../dist/domains/cats/services/stores/redis/RedisDraftStore.js');
    const redis = new FakeRedis();
    const store = new RedisDraftStore(redis);

    const detailKey = 'draft:user-1:thread-1:inv-legacy';
    await redis.hset(detailKey, {
      userId: 'user-1',
      threadId: 'thread-1',
      invocationId: 'inv-legacy',
      catId: 'opus',
      content: 'legacy',
      updatedAt: '1000',
    });

    await store.upsert({
      userId: 'user-1',
      threadId: 'thread-1',
      invocationId: 'inv-legacy',
      catId: 'opus',
      content: 'latest',
      updatedAt: 9000,
    });

    assert.equal(await redis.hget(detailKey, 'createdAt'), '1000');
    assert.equal(await redis.hget(detailKey, 'updatedAt'), '9000');
  });

  it('sets no expiry on the draft or its index (F117 KD-23)', async () => {
    const { RedisDraftStore } = await import('../dist/domains/cats/services/stores/redis/RedisDraftStore.js');
    const redis = new FakeRedis();
    const store = new RedisDraftStore(redis);

    await store.upsert({
      userId: 'user-1',
      threadId: 'thread-1',
      invocationId: 'inv-silent',
      catId: 'opus',
      content: 'streamed so far',
      updatedAt: 1000,
    });

    assert.deepEqual(redis.expired, [], 'a draft lives until its R ends, however long the turn is silent');
    assert.equal(typeof store.touch, 'undefined', 'nothing renews a draft on a timer any more');
    assert.equal(await redis.hget('draft:user-1:thread-1:inv-silent', 'content'), 'streamed so far');
  });

  it('clears the expiry a pre-KD-23 write left on the thread index and the draft', async () => {
    const { RedisDraftStore } = await import('../dist/domains/cats/services/stores/redis/RedisDraftStore.js');
    const redis = new FakeRedis();
    const store = new RedisDraftStore(redis);
    // The old store gave the per-thread index a 300 s expiry; a turn after the upgrade shares that index.
    await redis.sadd('drafts:idx:user-1:thread-1', 'inv-before-upgrade');
    await redis.expire('drafts:idx:user-1:thread-1', 300);
    await redis.expire('draft:user-1:thread-1:inv-after-upgrade', 300);

    await store.upsert({
      userId: 'user-1',
      threadId: 'thread-1',
      invocationId: 'inv-after-upgrade',
      catId: 'opus',
      content: 'a turn after the upgrade',
      updatedAt: 2000,
    });

    assert.equal(redis.ttls.has('drafts:idx:user-1:thread-1'), false, 'the old expiry would drop the new draft');
    assert.equal(redis.ttls.has('draft:user-1:thread-1:inv-after-upgrade'), false);
  });
});
