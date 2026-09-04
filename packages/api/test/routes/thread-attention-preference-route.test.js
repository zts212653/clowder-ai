import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('GET/PUT /api/config/thread-attention (F277)', () => {
  let app;
  let projectRoot;
  const OWNER_ID = 'test-owner-f277-attention';
  const headers = { 'x-cat-cafe-user': OWNER_ID };

  before(async () => {
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    projectRoot = await mkdtemp(join(tmpdir(), 'thread-attention-route-'));
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

  it('persists alias and open override without clobbering unrelated preferences', async () => {
    await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
    await writeFile(
      join(projectRoot, '.cat-cafe', 'user-preferences.json'),
      JSON.stringify({ catOrder: ['codex-sol'] }),
      'utf-8',
    );
    const alias = await app.inject({
      method: 'PUT',
      url: '/api/config/thread-attention',
      headers,
      payload: { anchor: 'group:attention_root', alias: 'F296 收口' },
    });
    assert.equal(alias.statusCode, 200, alias.payload);
    const open = await app.inject({
      method: 'PUT',
      url: '/api/config/thread-attention',
      headers,
      payload: { anchor: 'group:attention_root', open: false },
    });
    assert.equal(open.statusCode, 200, open.payload);

    const read = await app.inject({ method: 'GET', url: '/api/config/thread-attention', headers });
    assert.deepEqual(JSON.parse(read.payload), {
      aliases: { 'group:attention_root': 'F296 收口' },
      open: { 'group:attention_root': false },
      groups: [],
    });
    const persisted = JSON.parse(await readFile(join(projectRoot, '.cat-cafe', 'user-preferences.json'), 'utf-8'));
    assert.deepEqual(persisted.catOrder, ['codex-sol']);
  });

  it('preserves both fields when owner preference requests arrive concurrently', async () => {
    const [alias, open] = await Promise.all([
      app.inject({
        method: 'PUT',
        url: '/api/config/thread-attention',
        headers,
        payload: { anchor: 'group:attention_root', alias: 'F296 收口' },
      }),
      app.inject({
        method: 'PUT',
        url: '/api/config/thread-attention',
        headers,
        payload: { anchor: 'group:attention_root', open: false },
      }),
    ]);
    assert.equal(alias.statusCode, 200, alias.payload);
    assert.equal(open.statusCode, 200, open.payload);

    const read = await app.inject({ method: 'GET', url: '/api/config/thread-attention', headers });
    assert.deepEqual(JSON.parse(read.payload), {
      aliases: { 'group:attention_root': 'F296 收口' },
      open: { 'group:attention_root': false },
      groups: [],
    });
  });

  it('resets an alias, rejects unstable anchors, and rejects non-owner writes', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/config/thread-attention',
      headers,
      payload: { anchor: 'group:attention_root', alias: 'F296 收口' },
    });
    const reset = await app.inject({
      method: 'PUT',
      url: '/api/config/thread-attention',
      headers,
      payload: { anchor: 'group:attention_root', alias: null },
    });
    assert.deepEqual(JSON.parse(reset.payload).aliases, {});

    const unstable = await app.inject({
      method: 'PUT',
      url: '/api/config/thread-attention',
      headers,
      payload: { anchor: 'title:F296', alias: '猜的' },
    });
    assert.equal(unstable.statusCode, 400);
    const forbidden = await app.inject({
      method: 'PUT',
      url: '/api/config/thread-attention',
      headers: { 'x-cat-cafe-user': 'guest' },
      payload: { anchor: 'group:attention_root', open: true },
    });
    assert.equal(forbidden.statusCode, 403);
  });

  it('recovers an empty preference snapshot from corrupt storage', async () => {
    await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
    await writeFile(join(projectRoot, '.cat-cafe', 'user-preferences.json'), 'not json', 'utf-8');
    const read = await app.inject({ method: 'GET', url: '/api/config/thread-attention', headers });
    assert.equal(read.statusCode, 200);
    assert.deepEqual(JSON.parse(read.payload), {
      aliases: {},
      open: {},
      groups: [],
    });
  });
});
