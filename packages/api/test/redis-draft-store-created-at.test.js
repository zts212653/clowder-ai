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

  async expire() {
    return 1;
  }
}

describe('RedisDraftStore createdAt migration', () => {
  it('preserves legacy updatedAt as createdAt when upserting a hash without createdAt', async () => {
    const { RedisDraftStore } = await import('../dist/domains/cats/services/stores/redis/RedisDraftStore.js');
    const redis = new FakeRedis();
    const store = new RedisDraftStore(redis, { ttlSeconds: 300 });

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

  it('backfills legacy updatedAt as createdAt when touching a hash without createdAt', async () => {
    const { RedisDraftStore } = await import('../dist/domains/cats/services/stores/redis/RedisDraftStore.js');
    const redis = new FakeRedis();
    const store = new RedisDraftStore(redis, { ttlSeconds: 300 });

    const detailKey = 'draft:user-1:thread-1:inv-touch-only';
    await redis.hset(detailKey, {
      userId: 'user-1',
      threadId: 'thread-1',
      invocationId: 'inv-touch-only',
      catId: 'opus',
      content: '',
      updatedAt: '1000',
    });

    const originalNow = Date.now;
    Date.now = () => 9000;
    try {
      await store.touch('user-1', 'thread-1', 'inv-touch-only');
    } finally {
      Date.now = originalNow;
    }

    assert.equal(await redis.hget(detailKey, 'createdAt'), '1000');
    assert.equal(await redis.hget(detailKey, 'updatedAt'), '9000');
  });
});
