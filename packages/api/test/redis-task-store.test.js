/**
 * RedisTaskStore tests
 * 有 Redis → 测全量；无 Redis → skip
 * + TaskStoreFactory 分发测试 (always runs)
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

class FakeRedisForTaskStore {
  constructor() {
    this.hashes = new Map();
    this.strings = new Map();
    this.sortedSets = new Map();
    this.ttls = new Map();
    this.versions = new Map();
    this.watchedVersions = null;
  }

  async hset(key, value) {
    const existing = this.hashes.get(key) ?? {};
    this.hashes.set(key, { ...existing, ...value });
    this.bumpVersion(key);
    return 1;
  }

  async hgetall(key) {
    return this.hashes.get(key) ?? {};
  }

  async get(key) {
    return this.strings.get(key) ?? null;
  }

  async set(key, value) {
    this.strings.set(key, value);
    this.bumpVersion(key);
    return 'OK';
  }

  async setnx(key, value) {
    if (this.strings.has(key)) return 0;
    this.strings.set(key, value);
    this.bumpVersion(key);
    return 1;
  }

  async eval(script, _numKeys, ...keysAndArgs) {
    if (script.includes("redis.call('HSET'") && script.includes("redis.call('ZADD'")) {
      // Atomic owned write: KEYS=[subject, detail, thread, kind], ARGV=[taskId, score, ...fields]
      const [subjectKey, detailKey, threadKey, kindKey, expectedId, score, ...flatFields] = keysAndArgs;
      if ((this.strings.get(subjectKey) ?? null) !== expectedId) return 0;
      const hash = {};
      for (let i = 0; i < flatFields.length; i += 2) hash[flatFields[i]] = flatFields[i + 1];
      this.hashes.set(detailKey, { ...(this.hashes.get(detailKey) ?? {}), ...hash });
      this.bumpVersion(detailKey);
      const threadSet = this.sortedSets.get(threadKey) ?? new Map();
      threadSet.set(expectedId, Number(score));
      this.sortedSets.set(threadKey, threadSet);
      const kindSet = this.sortedSets.get(kindKey) ?? new Map();
      kindSet.set(expectedId, Number(score));
      this.sortedSets.set(kindKey, kindSet);
      return 1;
    }
    if (script.includes("redis.call('set'")) {
      const [key, expectedValue, nextValue] = keysAndArgs;
      if ((this.strings.get(key) ?? null) !== expectedValue) return 0;
      this.strings.set(key, nextValue);
      this.bumpVersion(key);
      return 1;
    }
    if (script.includes("redis.call('del'")) {
      const [key, expectedValue] = keysAndArgs;
      if ((this.strings.get(key) ?? null) !== expectedValue) return 0;
      this.strings.delete(key);
      this.bumpVersion(key);
      return 1;
    }
    throw new Error(`Unsupported eval script: ${script}`);
  }

  async zadd(key, score, member) {
    const set = this.sortedSets.get(key) ?? new Map();
    set.set(member, Number(score));
    this.sortedSets.set(key, set);
    this.bumpVersion(key);
    return 1;
  }

  async zrange(key, start, end) {
    const set = this.sortedSets.get(key) ?? new Map();
    const items = [...set.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([member]) => member);
    const normalizedEnd = end < 0 ? items.length + end + 1 : end + 1;
    return items.slice(start, normalizedEnd);
  }

  async zrem(key, member) {
    const set = this.sortedSets.get(key);
    if (!set) return 0;
    const deleted = set.delete(member) ? 1 : 0;
    if (deleted) this.bumpVersion(key);
    return deleted;
  }

  async del(key) {
    let deleted = 0;
    deleted += this.hashes.delete(key) ? 1 : 0;
    deleted += this.strings.delete(key) ? 1 : 0;
    deleted += this.sortedSets.delete(key) ? 1 : 0;
    this.ttls.delete(key);
    if (deleted) this.bumpVersion(key);
    return deleted;
  }

  async expire(key, ttl) {
    this.ttls.set(key, ttl);
    this.bumpVersion(key);
    return 1;
  }

  async persist(key) {
    this.ttls.delete(key);
    this.bumpVersion(key);
    return 1;
  }

  async watch(...keys) {
    this.watchedVersions = new Map(keys.map((key) => [key, this.getVersion(key)]));
    return 'OK';
  }

  async unwatch() {
    this.watchedVersions = null;
    return 'OK';
  }

  getVersion(key) {
    return this.versions.get(key) ?? 0;
  }

  bumpVersion(key) {
    this.versions.set(key, this.getVersion(key) + 1);
  }

  multi() {
    const ops = [];
    const pipeline = {
      hset: (key, value) => {
        ops.push(() => this.hset(key, value));
        return pipeline;
      },
      zadd: (key, score, member) => {
        ops.push(() => this.zadd(key, score, member));
        return pipeline;
      },
      set: (key, value) => {
        ops.push(() => this.set(key, value));
        return pipeline;
      },
      hgetall: (key) => {
        ops.push(() => this.hgetall(key));
        return pipeline;
      },
      zrem: (key, member) => {
        ops.push(() => this.zrem(key, member));
        return pipeline;
      },
      del: (key) => {
        ops.push(() => this.del(key));
        return pipeline;
      },
      exec: async () => {
        if (this.watchedVersions) {
          for (const [key, version] of this.watchedVersions.entries()) {
            if (this.getVersion(key) !== version) {
              this.watchedVersions = null;
              return null;
            }
          }
        }
        const results = [];
        for (const op of ops) {
          results.push([null, await op()]);
        }
        this.watchedVersions = null;
        return results;
      },
    };
    return pipeline;
  }
}

describe('RedisTaskStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisTaskStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisTaskStore');

    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisTaskStore.js');
    RedisTaskStore = storeModule.RedisTaskStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-task-store.test] Redis unreachable, skipping tests');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisTaskStore(redis, { ttlSeconds: 60 });
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['task:*', 'tasks:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['task:*', 'tasks:*']);
  });

  it('create stores task and listByThread returns it', async () => {
    const task = await store.create({
      threadId: 'test-thread-1',
      title: '修复 bug',
      createdBy: 'opus',
      why: '影响用户体验',
    });

    assert.ok(task.id, 'should have an id');
    assert.equal(task.threadId, 'test-thread-1');
    assert.equal(task.title, '修复 bug');
    assert.equal(task.status, 'todo');
    assert.equal(task.ownerCatId, null);

    const list = await store.listByThread('test-thread-1');
    assert.ok(list.length >= 1);
    assert.ok(list.some((t) => t.id === task.id));
  });

  it('get returns task by id', async () => {
    const task = await store.create({
      threadId: 'test-thread-2',
      title: '添加测试',
      createdBy: 'user',
      why: '提高覆盖率',
      ownerCatId: 'gemini',
    });

    const retrieved = await store.get(task.id);
    assert.ok(retrieved);
    assert.equal(retrieved.title, '添加测试');
    assert.equal(retrieved.ownerCatId, 'gemini');
    assert.equal(retrieved.createdBy, 'user');
  });

  it('update modifies fields', async () => {
    const task = await store.create({
      threadId: 'test-thread-3',
      title: '原始标题',
      createdBy: 'opus',
      why: '原始原因',
    });

    const updated = await store.update(task.id, {
      title: '新标题',
      status: 'doing',
      ownerCatId: 'codex',
    });

    assert.ok(updated);
    assert.equal(updated.title, '新标题');
    assert.equal(updated.status, 'doing');
    assert.equal(updated.ownerCatId, 'codex');
    assert.ok(updated.updatedAt >= task.updatedAt);
  });

  it('delete removes task', async () => {
    const task = await store.create({
      threadId: 'test-thread-4',
      title: '将被删除',
      createdBy: 'user',
      why: '测试删除',
    });

    const deleted = await store.delete(task.id);
    assert.equal(deleted, true);

    const retrieved = await store.get(task.id);
    assert.equal(retrieved, null);

    const deleted2 = await store.delete('nonexistent');
    assert.equal(deleted2, false);
  });
});

describe('TaskStoreFactory', () => {
  it('returns TaskStore when no redis, RedisTaskStore when redis', async () => {
    const { createTaskStore } = await import('../dist/domains/cats/services/stores/factories/TaskStoreFactory.js');
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const { RedisTaskStore } = await import('../dist/domains/cats/services/stores/redis/RedisTaskStore.js');

    const memoryStore = createTaskStore();
    assert.ok(memoryStore instanceof TaskStore, 'no redis → TaskStore');

    // With a fake redis object → RedisTaskStore
    const fakeRedis = { multi: () => ({}) };
    const redisStore = createTaskStore(fakeRedis);
    assert.ok(redisStore instanceof RedisTaskStore, 'redis → RedisTaskStore');
  });
});

describe('RedisTaskStore unit behavior', () => {
  it('re-registering a done pr_tracking task resets it back to todo', async () => {
    const { RedisTaskStore } = await import('../dist/domains/cats/services/stores/redis/RedisTaskStore.js');
    const redis = new FakeRedisForTaskStore();
    const store = new RedisTaskStore(redis, { ttlSeconds: 60 });

    const original = await store.upsertBySubject({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#42',
      threadId: 'thread-1',
      title: 'PR tracking: owner/repo#42',
      why: 'track pr',
      createdBy: 'opus',
    });
    await store.update(original.id, { status: 'done' });

    const reopened = await store.upsertBySubject({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#42',
      threadId: 'thread-2',
      title: 'PR tracking: owner/repo#42',
      why: 'track pr',
      createdBy: 'opus',
    });

    assert.equal(reopened.id, original.id);
    assert.equal(reopened.threadId, 'thread-2');
    assert.equal(reopened.status, 'todo');
  });

  it('does not leave a TTL on the shared thread index when active PR tracking exists', async () => {
    const { RedisTaskStore } = await import('../dist/domains/cats/services/stores/redis/RedisTaskStore.js');
    const { TaskKeys } = await import('../dist/domains/cats/services/stores/redis-keys/task-keys.js');
    const redis = new FakeRedisForTaskStore();
    const store = new RedisTaskStore(redis, { ttlSeconds: 60 });

    await store.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#42',
      threadId: 'thread-1',
      title: 'PR tracking: owner/repo#42',
      why: 'track pr',
      createdBy: 'opus',
    });
    const work = await store.create({
      threadId: 'thread-1',
      title: 'follow-up task',
      why: 'mixed thread',
      createdBy: 'opus',
    });

    await store.update(work.id, { status: 'done' });

    assert.equal(redis.ttls.get(TaskKeys.thread('thread-1')), undefined);
    const tasks = await store.listByThread('thread-1');
    assert.ok(tasks.some((task) => task.kind === 'pr_tracking'));
  });

  it('clears stale subject and kind indexes when the task hash has expired', async () => {
    const { RedisTaskStore } = await import('../dist/domains/cats/services/stores/redis/RedisTaskStore.js');
    const { TaskKeys } = await import('../dist/domains/cats/services/stores/redis-keys/task-keys.js');
    const redis = new FakeRedisForTaskStore();
    const store = new RedisTaskStore(redis, { ttlSeconds: 60 });

    const task = await store.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#77',
      threadId: 'thread-7',
      title: 'PR tracking: owner/repo#77',
      why: 'track pr',
      createdBy: 'opus',
    });

    redis.hashes.delete(TaskKeys.detail(task.id));

    const bySubject = await store.getBySubject('pr:owner/repo#77');
    assert.equal(bySubject, null);
    assert.equal(redis.strings.get(TaskKeys.subject('pr:owner/repo#77')), undefined);

    const byKind = await store.listByKind('pr_tracking');
    assert.deepEqual(byKind, []);
    const remainingKindIds = await redis.zrange(TaskKeys.kind('pr_tracking'), 0, -1);
    assert.deepEqual(remainingKindIds, []);

    const byThread = await store.listByThread('thread-7');
    assert.deepEqual(byThread, []);
    const remainingThreadIds = await redis.zrange(TaskKeys.thread('thread-7'), 0, -1);
    assert.deepEqual(remainingThreadIds, []);
  });

  it('does not delete a repaired subject mapping during stale cleanup', async () => {
    const { RedisTaskStore } = await import('../dist/domains/cats/services/stores/redis/RedisTaskStore.js');
    const { TaskKeys } = await import('../dist/domains/cats/services/stores/redis-keys/task-keys.js');
    const redis = new FakeRedisForTaskStore();
    const store = new RedisTaskStore(redis, { ttlSeconds: 60 });

    const staleTaskId = 'task-stale';
    const freshTaskId = 'task-fresh';
    redis.strings.set(TaskKeys.subject('pr:owner/repo#88'), staleTaskId);
    redis.hashes.set(TaskKeys.detail(freshTaskId), {
      id: freshTaskId,
      kind: 'pr_tracking',
      threadId: 'thread-8',
      subjectKey: 'pr:owner/repo#88',
      title: 'PR tracking: owner/repo#88',
      ownerCatId: '',
      status: 'todo',
      why: 'track pr',
      createdBy: 'opus',
      createdAt: '1',
      updatedAt: '1',
      userId: '',
    });

    const originalHgetall = redis.hgetall.bind(redis);
    let repaired = false;
    redis.hgetall = async (key) => {
      if (key === TaskKeys.detail(staleTaskId) && !repaired) {
        repaired = true;
        redis.strings.set(TaskKeys.subject('pr:owner/repo#88'), freshTaskId);
        return {};
      }
      return originalHgetall(key);
    };

    const result = await store.getBySubject('pr:owner/repo#88');
    assert.equal(result, null);
    assert.equal(redis.strings.get(TaskKeys.subject('pr:owner/repo#88')), freshTaskId);
  });

  it('recomputes TTL for the previous thread index when a tracked PR moves threads', async () => {
    const { RedisTaskStore } = await import('../dist/domains/cats/services/stores/redis/RedisTaskStore.js');
    const { TaskKeys } = await import('../dist/domains/cats/services/stores/redis-keys/task-keys.js');
    const redis = new FakeRedisForTaskStore();
    const store = new RedisTaskStore(redis, { ttlSeconds: 60 });

    await store.upsertBySubject({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#99',
      threadId: 'thread-old',
      title: 'PR tracking: owner/repo#99',
      why: 'track pr',
      createdBy: 'opus',
    });
    const oldThreadWork = await store.create({
      threadId: 'thread-old',
      title: 'old thread follow-up',
      why: 'cleanup',
      createdBy: 'opus',
    });
    await store.update(oldThreadWork.id, { status: 'done' });
    assert.equal(redis.ttls.get(TaskKeys.thread('thread-old')), undefined);

    await store.upsertBySubject({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#99',
      threadId: 'thread-new',
      title: 'PR tracking: owner/repo#99',
      why: 'track pr',
      createdBy: 'opus',
    });

    assert.equal(redis.ttls.get(TaskKeys.thread('thread-old')), 60);
    assert.equal(redis.ttls.get(TaskKeys.thread('thread-new')), undefined);
  });

  it('retries atomic upsert instead of blindly creating when subject GET races to null', async () => {
    const { RedisTaskStore } = await import('../dist/domains/cats/services/stores/redis/RedisTaskStore.js');
    const { TaskKeys } = await import('../dist/domains/cats/services/stores/redis-keys/task-keys.js');
    const redis = new FakeRedisForTaskStore();
    const store = new RedisTaskStore(redis, { ttlSeconds: 60 });

    const externalTaskId = 'task-existing';
    redis.hashes.set(TaskKeys.detail(externalTaskId), {
      id: externalTaskId,
      kind: 'pr_tracking',
      threadId: 'thread-existing',
      subjectKey: 'pr:owner/repo#123',
      title: 'PR tracking: owner/repo#123',
      ownerCatId: '',
      status: 'todo',
      why: 'track pr',
      createdBy: 'opus',
      createdAt: '1',
      updatedAt: '1',
      userId: '',
    });

    const originalSetnx = redis.setnx.bind(redis);
    const originalGet = redis.get.bind(redis);
    let firstSetnx = true;
    let firstGet = true;

    redis.setnx = async (key, value) => {
      if (key === TaskKeys.subject('pr:owner/repo#123') && firstSetnx) {
        firstSetnx = false;
        return 0;
      }
      return originalSetnx(key, value);
    };

    redis.get = async (key) => {
      if (key === TaskKeys.subject('pr:owner/repo#123') && firstGet) {
        firstGet = false;
        redis.strings.set(key, externalTaskId);
        return null;
      }
      return originalGet(key);
    };

    const result = await store.upsertBySubject({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#123',
      threadId: 'thread-new',
      title: 'PR tracking: owner/repo#123',
      why: 'track pr',
      createdBy: 'opus',
    });

    assert.equal(result.id, externalTaskId);
    assert.equal(redis.strings.get(TaskKeys.subject('pr:owner/repo#123')), externalTaskId);
    const kindIds = await redis.zrange(TaskKeys.kind('pr_tracking'), 0, -1);
    assert.deepEqual(kindIds, [externalTaskId]);
  });

  it('caps retries when subject lookup keeps racing to null', async () => {
    const { RedisTaskStore } = await import('../dist/domains/cats/services/stores/redis/RedisTaskStore.js');
    const { TaskKeys } = await import('../dist/domains/cats/services/stores/redis-keys/task-keys.js');
    const redis = new FakeRedisForTaskStore();
    const store = new RedisTaskStore(redis, { ttlSeconds: 60 });

    let subjectGetCalls = 0;
    redis.setnx = async () => 0;
    redis.get = async (key) => {
      if (key !== TaskKeys.subject('pr:owner/repo#125')) return null;
      subjectGetCalls += 1;
      if (subjectGetCalls > 5) {
        throw new Error('test breaker: subject lookup retry never stopped');
      }
      return null;
    };

    await assert.rejects(
      () =>
        store.upsertBySubject({
          kind: 'pr_tracking',
          subjectKey: 'pr:owner/repo#125',
          threadId: 'thread-null-race',
          title: 'PR tracking: owner/repo#125',
          why: 'track pr',
          createdBy: 'opus',
        }),
      /subject lookup kept returning null/i,
    );

    assert.equal(subjectGetCalls, 4);
    const kindIds = await redis.zrange(TaskKeys.kind('pr_tracking'), 0, -1);
    assert.deepEqual(kindIds, []);
  });

  it('recomputes thread TTL after deleting the last active pr_tracking task', async () => {
    const { RedisTaskStore } = await import('../dist/domains/cats/services/stores/redis/RedisTaskStore.js');
    const { TaskKeys } = await import('../dist/domains/cats/services/stores/redis-keys/task-keys.js');
    const redis = new FakeRedisForTaskStore();
    const store = new RedisTaskStore(redis, { ttlSeconds: 60 });

    const prTask = await store.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#321',
      threadId: 'thread-delete',
      title: 'PR tracking: owner/repo#321',
      why: 'track pr',
      createdBy: 'opus',
    });
    const doneWork = await store.create({
      threadId: 'thread-delete',
      title: 'done work',
      why: 'mixed thread',
      createdBy: 'opus',
    });
    await store.update(doneWork.id, { status: 'done' });
    assert.equal(redis.ttls.get(TaskKeys.thread('thread-delete')), undefined);

    const deleted = await store.delete(prTask.id);
    assert.equal(deleted, true);
    assert.equal(redis.ttls.get(TaskKeys.thread('thread-delete')), 60);
  });

  it('does not delete a repaired subject mapping when deleting a task', async () => {
    const { RedisTaskStore } = await import('../dist/domains/cats/services/stores/redis/RedisTaskStore.js');
    const { TaskKeys } = await import('../dist/domains/cats/services/stores/redis-keys/task-keys.js');
    const redis = new FakeRedisForTaskStore();
    const store = new RedisTaskStore(redis, { ttlSeconds: 60 });

    const staleTask = await store.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#500',
      threadId: 'thread-delete-race',
      title: 'PR tracking: owner/repo#500',
      why: 'track pr',
      createdBy: 'opus',
    });

    const freshTaskId = 'task-fresh-delete';
    redis.hashes.set(TaskKeys.detail(freshTaskId), {
      id: freshTaskId,
      kind: 'pr_tracking',
      threadId: 'thread-delete-race',
      subjectKey: 'pr:owner/repo#500',
      title: 'PR tracking: owner/repo#500',
      ownerCatId: '',
      status: 'todo',
      why: 'track pr',
      createdBy: 'opus',
      createdAt: '2',
      updatedAt: '2',
      userId: '',
    });

    const originalDel = redis.del.bind(redis);
    let repaired = false;
    redis.del = async (key) => {
      if (key === TaskKeys.detail(staleTask.id) && !repaired) {
        repaired = true;
        redis.strings.set(TaskKeys.subject('pr:owner/repo#500'), freshTaskId);
      }
      return originalDel(key);
    };

    const deleted = await store.delete(staleTask.id);
    assert.equal(deleted, true);

    const bySubject = await store.getBySubject('pr:owner/repo#500');
    assert.equal(bySubject?.id, freshTaskId);
  });

  it('does not delete a repaired subject mapping when deleting a thread', async () => {
    const { RedisTaskStore } = await import('../dist/domains/cats/services/stores/redis/RedisTaskStore.js');
    const { TaskKeys } = await import('../dist/domains/cats/services/stores/redis-keys/task-keys.js');
    const redis = new FakeRedisForTaskStore();
    const store = new RedisTaskStore(redis, { ttlSeconds: 60 });

    const staleTask = await store.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#700',
      threadId: 'thread-delete-by-thread',
      title: 'PR tracking: owner/repo#700',
      why: 'track pr',
      createdBy: 'opus',
    });

    const freshTaskId = 'task-fresh-delete-by-thread';
    redis.hashes.set(TaskKeys.detail(freshTaskId), {
      id: freshTaskId,
      kind: 'pr_tracking',
      threadId: 'thread-fresh',
      subjectKey: 'pr:owner/repo#700',
      title: 'PR tracking: owner/repo#700',
      ownerCatId: '',
      status: 'todo',
      why: 'track pr',
      createdBy: 'opus',
      createdAt: '2',
      updatedAt: '2',
      userId: '',
    });

    const originalDel = redis.del.bind(redis);
    let repaired = false;
    redis.del = async (key) => {
      if (key === TaskKeys.detail(staleTask.id) && !repaired) {
        repaired = true;
        redis.strings.set(TaskKeys.subject('pr:owner/repo#700'), freshTaskId);
      }
      return originalDel(key);
    };

    const deleted = await store.deleteByThread('thread-delete-by-thread');
    assert.equal(deleted, 1);

    const bySubject = await store.getBySubject('pr:owner/repo#700');
    assert.equal(bySubject?.id, freshTaskId);
  });

  it('retries when the claimed task hash is temporarily missing before treating it as orphan', async () => {
    const { RedisTaskStore } = await import('../dist/domains/cats/services/stores/redis/RedisTaskStore.js');
    const { TaskKeys } = await import('../dist/domains/cats/services/stores/redis-keys/task-keys.js');
    const redis = new FakeRedisForTaskStore();
    const store = new RedisTaskStore(redis, { ttlSeconds: 60 });

    const existingTaskId = 'task-inflight';
    redis.strings.set(TaskKeys.subject('pr:owner/repo#124'), existingTaskId);
    redis.hashes.set(TaskKeys.detail(existingTaskId), {
      id: existingTaskId,
      kind: 'pr_tracking',
      threadId: 'thread-existing',
      subjectKey: 'pr:owner/repo#124',
      title: 'PR tracking: owner/repo#124',
      ownerCatId: '',
      status: 'todo',
      why: 'track pr',
      createdBy: 'opus',
      createdAt: '1',
      updatedAt: '1',
      userId: '',
    });

    const originalHgetall = redis.hgetall.bind(redis);
    let firstLookup = true;
    redis.hgetall = async (key) => {
      if (key === TaskKeys.detail(existingTaskId) && firstLookup) {
        firstLookup = false;
        return {};
      }
      return originalHgetall(key);
    };

    const result = await store.upsertBySubject({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#124',
      threadId: 'thread-new',
      title: 'PR tracking: owner/repo#124',
      why: 'track pr',
      createdBy: 'opus',
    });

    assert.equal(result.id, existingTaskId);
    assert.equal(redis.strings.get(TaskKeys.subject('pr:owner/repo#124')), existingTaskId);
    const kindIds = await redis.zrange(TaskKeys.kind('pr_tracking'), 0, -1);
    assert.deepEqual(kindIds, [existingTaskId]);
  });

  it('preserves concurrent automationState subtree patches', async () => {
    const { RedisTaskStore } = await import('../dist/domains/cats/services/stores/redis/RedisTaskStore.js');
    const { TaskKeys } = await import('../dist/domains/cats/services/stores/redis-keys/task-keys.js');
    const redis = new FakeRedisForTaskStore();
    const store = new RedisTaskStore(redis, { ttlSeconds: 60 });

    const task = await store.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#800',
      threadId: 'thread-automation-race',
      title: 'PR tracking: owner/repo#800',
      why: 'track pr',
      createdBy: 'opus',
      automationState: {
        ci: { headSha: 'sha-old', lastFingerprint: 'ci-old' },
        conflict: { mergeState: 'MERGEABLE' },
      },
    });

    const originalHgetall = redis.hgetall.bind(redis);
    const originalHset = redis.hset.bind(redis);
    let injected = false;
    redis.hgetall = async (key) => {
      if (key === TaskKeys.detail(task.id) && !injected) {
        injected = true;
        const snapshot = await originalHgetall(key);
        await originalHset(key, {
          automationState: JSON.stringify({
            ci: { headSha: 'sha-old', lastFingerprint: 'ci-old' },
            conflict: { mergeState: 'CONFLICTING', lastFingerprint: 'conflict-new' },
          }),
          updatedAt: String(task.updatedAt + 1),
        });
        return snapshot;
      }
      return originalHgetall(key);
    };

    const updated = await store.patchAutomationState(task.id, {
      ci: { lastFingerprint: 'ci-new', headSha: 'sha-new' },
    });

    assert.equal(updated?.automationState?.ci?.lastFingerprint, 'ci-new');
    assert.equal(updated?.automationState?.conflict?.lastFingerprint, 'conflict-new');
    assert.equal(updated?.automationState?.conflict?.mergeState, 'CONFLICTING');
  });

  it('does not write a stale claimed task after CAS takeover', async () => {
    const { RedisTaskStore } = await import('../dist/domains/cats/services/stores/redis/RedisTaskStore.js');
    const { TaskKeys } = await import('../dist/domains/cats/services/stores/redis-keys/task-keys.js');
    const redis = new FakeRedisForTaskStore();
    const store = new RedisTaskStore(redis, { ttlSeconds: 60 });

    let releaseFirstWrite;
    const firstWriteBlocked = new Promise((resolve) => {
      releaseFirstWrite = resolve;
    });
    const originalEval = redis.eval.bind(redis);
    let blocked = false;
    redis.eval = async (script, numKeys, ...keysAndArgs) => {
      if (!blocked && script.includes("redis.call('HSET'")) {
        blocked = true;
        await firstWriteBlocked;
      }
      return originalEval(script, numKeys, ...keysAndArgs);
    };

    const first = store.upsertBySubject({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#801',
      threadId: 'thread-a',
      title: 'PR tracking: owner/repo#801',
      why: 'track pr',
      createdBy: 'opus',
    });

    while (!redis.strings.get(TaskKeys.subject('pr:owner/repo#801'))) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const firstClaimedTaskId = redis.strings.get(TaskKeys.subject('pr:owner/repo#801'));

    const secondTask = await store.upsertBySubject({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#801',
      threadId: 'thread-b',
      title: 'PR tracking: owner/repo#801',
      why: 'track pr',
      createdBy: 'opus',
    });

    releaseFirstWrite();
    const firstTask = await first;

    assert.equal(firstTask.id, secondTask.id, 'stale claimer should resolve to the current subject owner');
    const bySubject = await store.getBySubject('pr:owner/repo#801');
    assert.equal(bySubject?.id, secondTask.id);

    const byKind = await store.listByKind('pr_tracking');
    assert.deepEqual(
      byKind.map((task) => task.id),
      [secondTask.id],
      'stale claimer must not leave a zombie pr_tracking row behind',
    );
    assert.equal(await store.get(firstClaimedTaskId), null, 'stale claimed task hash must not be persisted');
  });
});
