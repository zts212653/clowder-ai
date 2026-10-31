import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { configThreadAttentionRoutes } from '../../src/routes/config-thread-attention.js';

test('owner can persist per-Group peek without changing collapse, aliases or another Group; reset restores default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'group-peek-pref-'));
  const oldOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'peek-owner';
  const app = Fastify();
  await app.register(configThreadAttentionRoutes, { projectRoot: root });
  const headers = { 'x-cat-cafe-user': 'peek-owner' };
  try {
    for (const payload of [
      { anchor: 'group:attention_one', open: false, alias: 'One' },
      { anchor: 'group:attention_one', collapsedPeek: false },
      { anchor: 'group:attention_two', collapsedPeek: true },
    ]) {
      const response = await app.inject({ method: 'PUT', url: '/api/config/thread-attention', headers, payload });
      assert.equal(response.statusCode, 200, response.body);
    }
    const saved = (await app.inject({ method: 'GET', url: '/api/config/thread-attention', headers })).json();
    assert.deepEqual(saved.collapsedPeek, { 'group:attention_one': false, 'group:attention_two': true });
    assert.deepEqual(saved.open, { 'group:attention_one': false });
    assert.deepEqual(saved.aliases, { 'group:attention_one': 'One' });
    const forbidden = await app.inject({
      method: 'PUT',
      url: '/api/config/thread-attention',
      headers: { 'x-cat-cafe-user': 'foreign' },
      payload: { anchor: 'group:attention_one', collapsedPeek: true },
    });
    assert.equal(forbidden.statusCode, 403);
    const reset = await app.inject({
      method: 'PUT',
      url: '/api/config/thread-attention',
      headers,
      payload: { anchor: 'group:attention_one', collapsedPeek: null },
    });
    assert.deepEqual(reset.json().collapsedPeek, { 'group:attention_two': true });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
    if (oldOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = oldOwner;
  }
});
