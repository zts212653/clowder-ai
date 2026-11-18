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
const headers = { 'x-cat-cafe-user': 'quota-pin-owner' };
const url = '/api/config/quota-pin';

async function start() {
  app = Fastify();
  await app.register(configRoutes, { projectRoot: root });
  await app.ready();
}

beforeEach(async () => {
  process.env.DEFAULT_OWNER_USER_ID = 'quota-pin-owner';
  root = await mkdtemp(join(tmpdir(), 'quota-pin-preference-'));
  await start();
});

afterEach(async () => {
  await app?.close();
  if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
  else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
  await rm(root, { recursive: true, force: true });
});

it('defaults to pinned with null account selection and persists user choices across restarts', async () => {
  await mkdir(join(root, '.cat-cafe'), { recursive: true });
  const prefs = join(root, '.cat-cafe/user-preferences.json');
  await writeFile(prefs, JSON.stringify({ catOrder: ['codex61-sol'] }));

  const initial = await app.inject({ url, headers });
  assert.equal(initial.statusCode, 200, initial.body);
  assert.deepEqual(initial.json(), { pinned: true, selectedAccountRefs: null });

  const customAccounts = await app.inject({
    method: 'PUT',
    url,
    headers,
    payload: { selectedAccountRefs: ['codex-main', 'claude', 'codex-main'] },
  });
  assert.equal(customAccounts.statusCode, 200, customAccounts.body);
  assert.deepEqual(customAccounts.json(), {
    pinned: true,
    selectedAccountRefs: ['codex-main', 'claude'],
  });

  const hidden = await app.inject({
    method: 'PUT',
    url,
    headers,
    payload: { pinned: false },
  });
  assert.equal(hidden.statusCode, 200, hidden.body);
  assert.deepEqual(hidden.json(), {
    pinned: false,
    selectedAccountRefs: ['codex-main', 'claude'],
  });

  await app.close();
  await start();

  const reloaded = await app.inject({ url, headers });
  assert.equal(reloaded.statusCode, 200);
  assert.deepEqual(reloaded.json(), {
    pinned: false,
    selectedAccountRefs: ['codex-main', 'claude'],
  });

  const emptyChoice = await app.inject({
    method: 'PUT',
    url,
    headers,
    payload: { pinned: true, selectedAccountRefs: [] },
  });
  assert.equal(emptyChoice.statusCode, 200);
  assert.deepEqual(emptyChoice.json(), { pinned: true, selectedAccountRefs: [] });

  const stored = JSON.parse(await readFile(prefs, 'utf8'));
  assert.deepEqual(stored.catOrder, ['codex61-sol']);
});

it('enforces owner auth, payload validation, and corrupt preference file protection', async () => {
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ url, headers: { 'x-cat-cafe-user': 'stranger' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PUT', url, headers, payload: { pinned: 'yes' } })).statusCode, 400);
  assert.equal(
    (await app.inject({ method: 'PUT', url, headers, payload: { selectedAccountRefs: [''] } })).statusCode,
    400,
  );

  await mkdir(join(root, '.cat-cafe'), { recursive: true });
  const path = join(root, '.cat-cafe/user-preferences.json');
  await writeFile(path, '{corrupt');
  assert.equal((await app.inject({ method: 'PUT', url, headers, payload: { pinned: false } })).statusCode, 503);
  assert.equal(await readFile(path, 'utf8'), '{corrupt');
});
