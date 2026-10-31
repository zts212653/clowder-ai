import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, it } from 'node:test';
import Fastify from 'fastify';
import { configRoutes } from '../../dist/routes/config.js';

let app;
let root;
const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
const headers = { 'x-cat-cafe-user': 'fold-owner' };
const url = '/api/config/live-projects';
async function start() {
  app = Fastify();
  await app.register(configRoutes, { projectRoot: root });
  await app.ready();
}
beforeEach(async () => {
  process.env.DEFAULT_OWNER_USER_ID = 'fold-owner';
  root = await mkdtemp(join(tmpdir(), 'live-project-preference-'));
  await start();
});
afterEach(async () => {
  await app?.close();
  if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
  else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
  await rm(root, { recursive: true, force: true });
});
it('persists independent folds across API recreation while preserving sibling preferences', async () => {
  await mkdir(join(root, '.cat-cafe'), { recursive: true });
  const prefs = join(root, '.cat-cafe/user-preferences.json');
  await writeFile(prefs, JSON.stringify({ conversationViews: { threads: {} }, catOrder: ['kimi'] }));
  assert.deepEqual((await app.inject({ url, headers })).json(), { collapsed: {} });
  for (const [projectPath, collapsed] of [
    ['/planet', true],
    ['/cafe', true],
    ['/cafe', false],
  ]) {
    const saved = await app.inject({ method: 'PUT', url, headers, payload: { projectPath, collapsed } });
    assert.equal(saved.statusCode, 200);
  }
  await app.close();
  await start();
  assert.deepEqual((await app.inject({ url, headers })).json(), { collapsed: { '/planet': true, '/cafe': false } });
  const stored = JSON.parse(await readFile(prefs, 'utf8'));
  assert.deepEqual(stored.catOrder, ['kimi']);
  assert.deepEqual(stored.conversationViews, { threads: {} });
});
it('requires the owner and validates writes before touching preferences', async () => {
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ url, headers: { 'x-cat-cafe-user': 'stranger' } })).statusCode, 403);
  assert.equal(
    (await app.inject({ method: 'PUT', url, headers, payload: { projectPath: '/planet', collapsed: 'yes' } }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url,
        headers: { origin: 'http://localhost:3003' },
        payload: { projectPath: '/planet', collapsed: true },
      })
    ).statusCode,
    401,
  );
});
it('refuses to overwrite unreadable sibling preferences', async () => {
  await mkdir(join(root, '.cat-cafe'), { recursive: true });
  const path = join(root, '.cat-cafe/user-preferences.json');
  await writeFile(path, '{unfinished');
  assert.equal(
    (await app.inject({ method: 'PUT', url, headers, payload: { projectPath: '/planet', collapsed: true } }))
      .statusCode,
    503,
  );
  assert.equal(await readFile(path, 'utf8'), '{unfinished');
});

it('persists separate Home fold sections without losing the live project choice', async () => {
  for (const [section, collapsed] of [
    ['live', true],
    ['waiting', false],
    ['deployment', false],
  ]) {
    const result = await app.inject({
      method: 'PUT',
      url: `${url}?section=${section}`,
      headers,
      payload: { projectPath: '/planet', collapsed },
    });
    assert.equal(result.statusCode, 200, result.body);
  }
  await app.close();
  await start();
  for (const [section, collapsed] of [
    ['live', true],
    ['waiting', false],
    ['deployment', false],
  ]) {
    const result = await app.inject({ url: `${url}?section=${section}`, headers });
    assert.deepEqual(result.json(), { collapsed: { '/planet': collapsed } });
  }
  assert.equal((await app.inject({ url: `${url}?section=unknown`, headers })).statusCode, 400);
});
