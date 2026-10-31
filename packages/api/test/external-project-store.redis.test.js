/**
 * ExternalProjectStore Redis integration tests.
 * Skipped when REDIS_URL is not available or isolation flag is not set.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { cleanupPrefixedRedisKeys } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const ISOLATED = process.env.CAT_CAFE_REDIS_TEST_ISOLATED === '1';
const shouldSkipSuite = !REDIS_URL || !ISOLATED;

describe('ExternalProjectStore (Redis)', { skip: shouldSkipSuite ? 'Redis isolation not configured' : false }, () => {
  let ExternalProjectStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    const storeModule = await import('../dist/domains/projects/external-project-store.js');
    ExternalProjectStore = storeModule.ExternalProjectStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[external-project-store.redis.test] Redis unreachable, skipping tests');
      await redis.quit().catch(() => {});
    }
    if (connected) {
      store = new ExternalProjectStore(redis);
    }
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['external:project:*', 'external:projects:user:*']);
      await redis.quit();
    }
  });

  beforeEach(async () => {
    if (!connected) return;
    await cleanupPrefixedRedisKeys(redis, ['external:project:*', 'external:projects:user:*']);
  });

  it('create() persists project to Redis', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    const project = await store.create('user1', {
      name: 'studio-flow',
      description: 'Test project',
      sourcePath: '/tmp/studio-flow',
    });
    assert.ok(project.id.startsWith('ep-'));

    const fetched = await store.getById(project.id);
    assert.deepStrictEqual(fetched, project);
  });

  it('listByUser() returns projects newest-first', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await store.create('user1', { name: 'a', description: '', sourcePath: '/a' });
    await store.create('user1', { name: 'b', description: '', sourcePath: '/b' });
    await store.create('user2', { name: 'c', description: '', sourcePath: '/c' });

    const user1Projects = await store.listByUser('user1');
    assert.equal(user1Projects.length, 2);
    assert.equal(user1Projects[0].name, 'b');
    assert.equal(user1Projects[1].name, 'a');
    assert.equal((await store.listByUser('user2')).length, 1);
  });

  it('update() modifies fields and bumps updatedAt', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    const created = await store.create('user1', { name: 'old', description: '', sourcePath: '/old' });
    const updated = await store.update(created.id, { name: 'new', sourcePath: '/new' });
    assert.equal(updated.name, 'new');
    assert.equal(updated.sourcePath, '/new');
    assert.ok(updated.updatedAt >= created.updatedAt);

    const fetched = await store.getById(created.id);
    assert.equal(fetched.name, 'new');
  });

  it('delete() removes project from Redis', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    const created = await store.create('user1', { name: 'del', description: '', sourcePath: '/del' });
    assert.equal(await store.delete(created.id), true);
    assert.equal(await store.getById(created.id), null);
    assert.equal(await store.delete(created.id), false);
  });

  it('survives store re-instantiation (read after restart)', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    const project = await store.create('user1', {
      name: 'persistent',
      description: '',
      sourcePath: '/persistent',
    });

    // Simulate restart: create a new store instance with the same Redis
    const newStore = new ExternalProjectStore(redis);
    const fetched = await newStore.getById(project.id);
    assert.equal(fetched.name, 'persistent');

    const listed = await newStore.listByUser('user1');
    assert.equal(listed.length, 1);
  });
});
