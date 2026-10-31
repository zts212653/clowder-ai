import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

class MockRedisHash {
  constructor() {
    /** @type {Map<string, Map<string, string>>} */
    this.hashes = new Map();
    /** @type {Array<{key: string, ttl: number}>} */
    this.expireCalls = [];
  }

  /** @param {string} key @param {string} field */
  async hget(key, field) {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  /** @param {string} key @param {string} field @param {string} value */
  async hset(key, field, value) {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    h.set(field, value);
    return 1;
  }

  /** @param {string} key */
  async hgetall(key) {
    const h = this.hashes.get(key);
    if (!h) return {};
    return Object.fromEntries(h.entries());
  }

  /** @param {string} key @param {string} field */
  async hdel(key, field) {
    const h = this.hashes.get(key);
    if (!h) return 0;
    const existed = h.delete(field);
    if (h.size === 0) this.hashes.delete(key);
    return existed ? 1 : 0;
  }

  /**
   * @param {string} _script
   * @param {number} _numKeys
   * @param {string} key
   * @param {string} field
   * @param {string} invocationId
   */
  async eval(_script, _numKeys, key, field, invocationId) {
    const raw = await this.hget(key, field);
    if (!raw) return 0;
    let snapshot;
    try {
      snapshot = JSON.parse(raw);
    } catch {
      return 0;
    }
    if (snapshot.lastInvocationId !== invocationId) return 0;
    return this.hdel(key, field);
  }

  /** @param {string} key @param {number} ttl */
  async expire(key, ttl) {
    this.expireCalls.push({ key, ttl });
    return 1;
  }

  /** @param {string} key */
  async del(key) {
    const existed = this.hashes.delete(key);
    return existed ? 1 : 0;
  }
}

describe('RedisTaskProgressStore', () => {
  test('setSnapshot/getSnapshot/getThreadSnapshots/deleteSnapshot', async () => {
    const { RedisTaskProgressStore } = await import(
      '../dist/domains/cats/services/agents/invocation/RedisTaskProgressStore.js'
    );

    const redis = new MockRedisHash();
    const store = new RedisTaskProgressStore(redis, 123);

    const snapshot = {
      threadId: 'thread_1',
      catId: 'opus',
      tasks: [
        { id: 't1', subject: 'Read files', status: 'completed' },
        { id: 't2', subject: 'Fix bug', status: 'pending' },
      ],
      status: 'interrupted',
      updatedAt: 1700000000000,
      lastInvocationId: 'inv_123',
      interruptReason: 'killed',
    };

    await store.setSnapshot(snapshot);
    const got = await store.getSnapshot('thread_1', 'opus');
    assert.deepEqual(got, snapshot);

    const thread = await store.getThreadSnapshots('thread_1');
    assert.equal(Object.keys(thread).length, 1);
    assert.deepEqual(thread.opus, snapshot);

    await store.deleteSnapshot('thread_1', 'opus');
    const afterDelete = await store.getSnapshot('thread_1', 'opus');
    assert.equal(afterDelete, null);
  });

  test('setSnapshot uses default ttl unless overridden', async () => {
    const { RedisTaskProgressStore } = await import(
      '../dist/domains/cats/services/agents/invocation/RedisTaskProgressStore.js'
    );

    const redis = new MockRedisHash();
    const store = new RedisTaskProgressStore(redis, 111);

    await store.setSnapshot({
      threadId: 'thread_2',
      catId: 'opus',
      tasks: [],
      status: 'running',
      updatedAt: 1,
    });
    assert.deepEqual(redis.expireCalls.at(-1), { key: 'task-progress:thread_2', ttl: 111 });

    await store.setSnapshot(
      {
        threadId: 'thread_2',
        catId: 'codex',
        tasks: [],
        status: 'running',
        updatedAt: 2,
      },
      { ttlSeconds: 222 },
    );
    assert.deepEqual(redis.expireCalls.at(-1), { key: 'task-progress:thread_2', ttl: 222 });
  });

  test('deleteThread clears the whole hash key', async () => {
    const { RedisTaskProgressStore } = await import(
      '../dist/domains/cats/services/agents/invocation/RedisTaskProgressStore.js'
    );

    const redis = new MockRedisHash();
    const store = new RedisTaskProgressStore(redis, 10);

    await store.setSnapshot({
      threadId: 'thread_3',
      catId: 'opus',
      tasks: [],
      status: 'running',
      updatedAt: 1,
    });
    await store.setSnapshot({
      threadId: 'thread_3',
      catId: 'codex',
      tasks: [],
      status: 'running',
      updatedAt: 2,
    });
    assert.equal(Object.keys(await store.getThreadSnapshots('thread_3')).length, 2);

    await store.deleteThread('thread_3');
    assert.deepEqual(await store.getThreadSnapshots('thread_3'), {});
  });

  test('deleteSnapshotIfOwner atomically preserves a replacement invocation snapshot', async () => {
    const { RedisTaskProgressStore } = await import(
      '../dist/domains/cats/services/agents/invocation/RedisTaskProgressStore.js'
    );

    const redis = new MockRedisHash();
    const store = new RedisTaskProgressStore(redis, 0);
    const replacement = {
      threadId: 'thread_owner',
      catId: 'opus',
      tasks: [],
      status: 'running',
      updatedAt: 2,
      lastInvocationId: 'replacement-B',
    };
    await store.setSnapshot(replacement);

    assert.equal(await store.deleteSnapshotIfOwner('thread_owner', 'opus', 'zombie-A'), false);
    assert.deepEqual(await store.getSnapshot('thread_owner', 'opus'), replacement);
    assert.equal(await store.deleteSnapshotIfOwner('thread_owner', 'opus', 'replacement-B'), true);
    assert.equal(await store.getSnapshot('thread_owner', 'opus'), null);

    await redis.hset('task-progress:thread_owner', 'opus', '{malformed');
    assert.equal(await store.deleteSnapshotIfOwner('thread_owner', 'opus', 'replacement-B'), false);
    assert.equal(await redis.hget('task-progress:thread_owner', 'opus'), '{malformed');
  });
});

describe('MemoryTaskProgressStore', () => {
  test('deleteSnapshotIfOwner preserves a replacement invocation snapshot', async () => {
    const { MemoryTaskProgressStore } = await import(
      '../dist/domains/cats/services/agents/invocation/MemoryTaskProgressStore.js'
    );
    const store = new MemoryTaskProgressStore();
    const replacement = {
      threadId: 'thread_owner',
      catId: 'opus',
      tasks: [],
      status: 'running',
      updatedAt: 2,
      lastInvocationId: 'replacement-B',
    };
    await store.setSnapshot(replacement);

    assert.equal(await store.deleteSnapshotIfOwner('thread_owner', 'opus', 'zombie-A'), false);
    assert.deepEqual(await store.getSnapshot('thread_owner', 'opus'), replacement);
    assert.equal(await store.deleteSnapshotIfOwner('thread_owner', 'opus', 'replacement-B'), true);
    assert.equal(await store.getSnapshot('thread_owner', 'opus'), null);
    assert.equal(await store.deleteSnapshotIfOwner('thread_owner', 'opus', 'replacement-B'), false);
  });
});
