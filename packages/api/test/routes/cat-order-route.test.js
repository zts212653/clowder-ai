import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { CAT_CONFIGS, catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';

describe('GET/PUT /api/config/cat-order (F166)', () => {
  let app;
  let projectRoot;
  const OWNER_ID = 'test-owner-f166';

  before(async () => {
    catRegistry.reset();
    catRegistry.register('opus', CAT_CONFIGS.opus);
    catRegistry.register('codex', CAT_CONFIGS.codex);
    catRegistry.register('gemini', CAT_CONFIGS.gemini);
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    projectRoot = await mkdtemp(join(tmpdir(), 'cat-order-route-'));
    const { configRoutes } = await import('../../dist/routes/config.js');
    app = Fastify();
    await app.register(configRoutes, { projectRoot });
    await app.ready();
  });

  after(async () => {
    catRegistry.reset();
    delete process.env.DEFAULT_OWNER_USER_ID;
    await app?.close();
    await rm(projectRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(join(projectRoot, '.cat-cafe'), { recursive: true, force: true });
  });

  it('GET returns empty array when no order saved', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config/cat-order' });
    assert.equal(res.statusCode, 200, `expected 200 but got ${res.statusCode}: ${res.payload}`);
    const body = JSON.parse(res.payload);
    assert.deepEqual(body.catOrder, []);
  });

  it('PUT by owner persists catOrder to preferences file', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/cat-order',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { catOrder: ['codex', 'gemini', 'opus'] },
    });
    assert.equal(res.statusCode, 200, `expected 200 but got ${res.statusCode}: ${res.payload}`);
    const body = JSON.parse(res.payload);
    assert.deepEqual(body.catOrder, ['codex', 'gemini', 'opus']);

    const raw = JSON.parse(await readFile(join(projectRoot, '.cat-cafe', 'user-preferences.json'), 'utf-8'));
    assert.deepEqual(raw.catOrder, ['codex', 'gemini', 'opus']);
  });

  it('GET reflects persisted order after PUT', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/config/cat-order',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { catOrder: ['gemini', 'opus'] },
    });
    const res = await app.inject({ method: 'GET', url: '/api/config/cat-order' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.deepEqual(body.catOrder, ['gemini', 'opus']);
  });

  it('PUT by non-owner → 403', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/cat-order',
      headers: { 'x-cat-cafe-user': 'guest-user' },
      payload: { catOrder: ['opus'] },
    });
    assert.equal(res.statusCode, 403, `expected 403 but got ${res.statusCode}: ${res.payload}`);
  });

  it('PUT without user header → 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/cat-order',
      payload: { catOrder: ['opus'] },
    });
    assert.equal(res.statusCode, 400);
  });

  it('PUT with unknown catId → 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/cat-order',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { catOrder: ['opus', 'nonexistent-cat'] },
    });
    assert.equal(res.statusCode, 400, `expected 400 but got ${res.statusCode}: ${res.payload}`);
    const body = JSON.parse(res.payload);
    assert.match(body.error, /nonexistent-cat/);
  });

  it('PUT with duplicate catIds deduplicates (keeps first occurrence)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/cat-order',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { catOrder: ['codex', 'opus', 'codex', 'gemini', 'opus'] },
    });
    assert.equal(res.statusCode, 200, `expected 200 but got ${res.statusCode}: ${res.payload}`);
    const body = JSON.parse(res.payload);
    assert.deepEqual(body.catOrder, ['codex', 'opus', 'gemini']);
  });

  it('PUT with empty array clears order', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/config/cat-order',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { catOrder: ['codex'] },
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/cat-order',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { catOrder: [] },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.deepEqual(body.catOrder, []);
  });
});
