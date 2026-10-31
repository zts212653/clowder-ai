/**
 * Label API route tests — real Fastify inject
 * Uses real Redis via test:redis harness
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('Label API routes (Fastify inject)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisLabelStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'LabelRoutes');

    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisLabelStore.js');
    RedisLabelStore = storeModule.RedisLabelStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[label-routes.test] Redis unreachable, skipping tests');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisLabelStore(redis);
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['label:*', 'labels:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['label:*', 'labels:*']);
  });

  async function createApp() {
    const { labelsRoutes } = await import('../dist/routes/labels.js');
    const app = Fastify();
    await app.register(labelsRoutes, { labelStore: store });
    return app;
  }

  it('POST /api/labels creates a label and returns 201', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/labels',
      payload: { name: '开源拆解', color: '#5B8C5A' },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.name, '开源拆解');
    assert.equal(body.color, '#5B8C5A');
    assert.ok(body.id);
  });

  it('POST /api/labels rejects invalid color', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/labels',
      payload: { name: 'test', color: 'red' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('POST /api/labels rejects name over 20 chars', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/labels',
      payload: { name: 'a'.repeat(21), color: '#FF0000' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('GET /api/labels returns user labels', async () => {
    await store.create({
      id: 'get_lbl_1',
      name: '测试',
      color: '#111111',
      sortOrder: 0,
      createdBy: 'default-user',
      createdAt: Date.now(),
    });
    const app = await createApp();
    const res = await app.inject({ method: 'GET', url: '/api/labels' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].name, '测试');
  });

  it('PATCH /api/labels/:id updates own label', async () => {
    await store.create({
      id: 'upd_lbl_1',
      name: '原名',
      color: '#111111',
      sortOrder: 0,
      createdBy: 'default-user',
      createdAt: Date.now(),
    });
    const app = await createApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/labels/upd_lbl_1',
      payload: { name: '新名' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().name, '新名');
  });

  it('PATCH /api/labels/:id returns 404 for other user label', async () => {
    await store.create({
      id: 'cross_lbl_1',
      name: 'alice标签',
      color: '#222222',
      sortOrder: 0,
      createdBy: 'alice',
      createdAt: Date.now(),
    });
    const app = await createApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/labels/cross_lbl_1',
      payload: { name: 'hijacked' },
    });
    assert.equal(res.statusCode, 404);
    const label = await store.get('cross_lbl_1');
    assert.equal(label?.name, 'alice标签');
  });

  it('PATCH /api/labels/:id rejects empty body', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/labels/any_id',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  });

  it('DELETE /api/labels/:id deletes own label', async () => {
    await store.create({
      id: 'del_lbl_1',
      name: '删我',
      color: '#333333',
      sortOrder: 0,
      createdBy: 'default-user',
      createdAt: Date.now(),
    });
    const app = await createApp();
    const res = await app.inject({ method: 'DELETE', url: '/api/labels/del_lbl_1' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
    const after = await store.list('default-user');
    assert.equal(after.length, 0);
  });

  it('DELETE /api/labels/:id returns 404 for other user label', async () => {
    await store.create({
      id: 'cross_del_1',
      name: 'alice的',
      color: '#444444',
      sortOrder: 0,
      createdBy: 'alice',
      createdAt: Date.now(),
    });
    const app = await createApp();
    const res = await app.inject({ method: 'DELETE', url: '/api/labels/cross_del_1' });
    assert.equal(res.statusCode, 404);
    const label = await store.get('cross_del_1');
    assert.ok(label, 'alice label should still exist');
  });

  it('DELETE /api/labels/:id returns 404 for non-existent label', async () => {
    const app = await createApp();
    const res = await app.inject({ method: 'DELETE', url: '/api/labels/nonexistent' });
    assert.equal(res.statusCode, 404);
  });

  it('DELETE /api/labels/:id strips labelId from threads', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const threadStore = new ThreadStore();
    const t1 = threadStore.create('default-user', 'tagged thread');
    const t2 = threadStore.create('default-user', 'multi-tagged');
    const t3 = threadStore.create('default-user', 'unrelated');
    threadStore.updateLabels(t1.id, ['del_strip_1']);
    threadStore.updateLabels(t2.id, ['del_strip_1', 'keep_lbl']);
    threadStore.updateLabels(t3.id, ['keep_lbl']);

    await store.create({
      id: 'del_strip_1',
      name: 'Strip me',
      color: '#FF0000',
      sortOrder: 0,
      createdBy: 'default-user',
      createdAt: Date.now(),
    });

    const { labelsRoutes } = await import('../dist/routes/labels.js');
    const app = Fastify();
    await app.register(labelsRoutes, { labelStore: store, threadStore });
    await app.ready();

    const res = await app.inject({ method: 'DELETE', url: '/api/labels/del_strip_1' });
    assert.equal(res.statusCode, 200);

    const after1 = threadStore.get(t1.id);
    assert.deepEqual(after1.labels, []);
    const after2 = threadStore.get(t2.id);
    assert.deepEqual(after2.labels, ['keep_lbl']);
    const after3 = threadStore.get(t3.id);
    assert.deepEqual(after3.labels, ['keep_lbl']);
  });

  it('DELETE /api/labels/:id strips labelId from trashed threads too', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const threadStore = new ThreadStore();
    const active = threadStore.create('default-user', 'active tagged');
    const trashed = threadStore.create('default-user', 'trashed tagged');
    threadStore.updateLabels(active.id, ['ghost_lbl']);
    threadStore.updateLabels(trashed.id, ['ghost_lbl', 'keep_lbl']);
    threadStore.softDelete(trashed.id);

    await store.create({
      id: 'ghost_lbl',
      name: 'Ghost',
      color: '#FF0000',
      sortOrder: 0,
      createdBy: 'default-user',
      createdAt: Date.now(),
    });

    const { labelsRoutes } = await import('../dist/routes/labels.js');
    const app = Fastify();
    await app.register(labelsRoutes, { labelStore: store, threadStore });
    await app.ready();

    const res = await app.inject({ method: 'DELETE', url: '/api/labels/ghost_lbl' });
    assert.equal(res.statusCode, 200);

    const afterActive = threadStore.get(active.id);
    assert.deepEqual(afterActive.labels, [], 'active thread should have ghost label stripped');
    const afterTrashed = threadStore.get(trashed.id);
    assert.deepEqual(afterTrashed.labels, ['keep_lbl'], 'trashed thread should also have ghost label stripped');
  });

  it('CRUD lifecycle via inject', async () => {
    const app = await createApp();

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/labels',
      payload: { name: '全流程', color: '#AABBCC', sortOrder: 5 },
    });
    assert.equal(createRes.statusCode, 201);
    const labelId = createRes.json().id;

    const listRes = await app.inject({ method: 'GET', url: '/api/labels' });
    assert.equal(listRes.json().length, 1);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/labels/${labelId}`,
      payload: { color: '#DDEEFF' },
    });
    assert.equal(patchRes.statusCode, 200);
    assert.equal(patchRes.json().color, '#DDEEFF');

    const delRes = await app.inject({ method: 'DELETE', url: `/api/labels/${labelId}` });
    assert.equal(delRes.statusCode, 200);

    const emptyList = await app.inject({ method: 'GET', url: '/api/labels' });
    assert.equal(emptyList.json().length, 0);
  });
});
