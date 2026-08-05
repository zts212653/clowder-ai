import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('GET/PUT /api/config/message-disposition (F264)', () => {
  let app;
  let projectRoot;
  const OWNER_ID = 'test-owner-f264-disposition';

  before(async () => {
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    projectRoot = await mkdtemp(join(tmpdir(), 'message-disposition-route-'));
    const { configRoutes } = await import('../../dist/routes/config.js');
    app = Fastify();
    await app.register(configRoutes, { projectRoot });
    await app.ready();
  });

  after(async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;
    await app?.close();
    await rm(projectRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(join(projectRoot, '.cat-cafe'), { recursive: true, force: true });
  });

  it('defaults to next-work and reports the product source', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/config/message-disposition?threadId=thread-a',
    });

    assert.equal(res.statusCode, 200, res.payload);
    assert.deepEqual(JSON.parse(res.payload), {
      productDefault: 'next_work',
      global: null,
      thread: null,
      effective: 'next_work',
      source: 'product',
      onboardingSeen: false,
    });
  });

  it('resolves thread over global and removing thread restores inheritance', async () => {
    const headers = { 'x-cat-cafe-user': OWNER_ID };
    await app.inject({
      method: 'PUT',
      url: '/api/config/message-disposition',
      headers,
      payload: { scope: 'global', disposition: 'continue_current' },
    });
    await app.inject({
      method: 'PUT',
      url: '/api/config/message-disposition',
      headers,
      payload: { scope: 'thread', threadId: 'thread-a', disposition: 'next_work' },
    });

    let res = await app.inject({ method: 'GET', url: '/api/config/message-disposition?threadId=thread-a' });
    assert.deepEqual(JSON.parse(res.payload), {
      productDefault: 'next_work',
      global: 'continue_current',
      thread: 'next_work',
      effective: 'next_work',
      source: 'thread',
      onboardingSeen: false,
    });

    res = await app.inject({
      method: 'PUT',
      url: '/api/config/message-disposition',
      headers,
      payload: { scope: 'thread', threadId: 'thread-a', disposition: null },
    });
    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(JSON.parse(res.payload).effective, 'continue_current');
    assert.equal(JSON.parse(res.payload).source, 'global');
  });

  it('persists onboarding monotonically and preserves unrelated preferences', async () => {
    const headers = { 'x-cat-cafe-user': OWNER_ID };
    await app.inject({
      method: 'PUT',
      url: '/api/config/cat-order',
      headers,
      payload: { catOrder: [] },
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/message-disposition',
      headers,
      payload: { scope: 'onboarding', seen: true },
    });

    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(JSON.parse(res.payload).onboardingSeen, true);
    const raw = JSON.parse(await readFile(join(projectRoot, '.cat-cafe', 'user-preferences.json'), 'utf-8'));
    assert.deepEqual(raw.catOrder, []);
    assert.equal(raw.messageDisposition.onboardingSeen, true);
  });

  it('rejects non-owner writes and invalid dispositions', async () => {
    const forbidden = await app.inject({
      method: 'PUT',
      url: '/api/config/message-disposition',
      headers: { 'x-cat-cafe-user': 'guest' },
      payload: { scope: 'global', disposition: 'continue_current' },
    });
    assert.equal(forbidden.statusCode, 403);

    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/config/message-disposition',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { scope: 'global', disposition: 'magic' },
    });
    assert.equal(invalid.statusCode, 400);
  });
});
