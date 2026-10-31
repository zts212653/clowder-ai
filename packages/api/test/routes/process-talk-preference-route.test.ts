import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { configRoutes } from '../../src/routes/config.js';

let app: FastifyInstance;
let projectRoot: string;
const owner = 'process-talk-owner';
const headers = { 'x-cat-cafe-user': owner };
const url = '/api/config/process-talk';
const preferencesPath = () => join(projectRoot, '.cat-cafe', 'user-preferences.json');
const save = (mode: string, identity = owner, expectedOwnerUserId = identity) =>
  app.inject({
    method: 'PUT',
    url,
    headers: { 'x-cat-cafe-user': identity },
    payload: { mode, expectedOwnerUserId },
  });
async function setup() {
  app = Fastify();
  await app.register(configRoutes, { projectRoot });
  await app.ready();
}
beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'f322-process-talk-'));
  process.env.DEFAULT_OWNER_USER_ID = owner;
  await setup();
});
afterEach(async () => {
  await app.close();
  delete process.env.DEFAULT_OWNER_USER_ID;
  await rm(projectRoot, { recursive: true, force: true });
});

test('defaults whole, persists per user across recreation, preserves unrelated preferences without TTL', async () => {
  await mkdir(join(projectRoot, '.cat-cafe'));
  await writeFile(preferencesPath(), JSON.stringify({ catOrder: ['opus55'], future: { keep: true } }));
  const initial = await app.inject({ method: 'GET', url, headers });
  assert.equal(initial.statusCode, 200, initial.payload);
  assert.deepEqual(initial.json(), { ownerUserId: owner, mode: 'whole' });
  const saved = await save('record');
  assert.equal(saved.statusCode, 200, saved.payload);
  assert.deepEqual(saved.json(), { ownerUserId: owner, mode: 'record' });
  await app.close();
  await setup();
  assert.deepEqual((await app.inject({ method: 'GET', url, headers })).json(), saved.json());
  const stored = JSON.parse(await readFile(preferencesPath(), 'utf8'));
  assert.deepEqual(stored.catOrder, ['opus55']);
  assert.deepEqual(stored.future, { keep: true });
  assert.deepEqual(stored.processTalk.owners[owner], { mode: 'record' });
  delete process.env.DEFAULT_OWNER_USER_ID;
  const other = await app.inject({ method: 'GET', url, headers: { 'x-cat-cafe-user': 'other' } });
  assert.deepEqual(other.json(), { ownerUserId: 'other', mode: 'whole' });
  assert.equal((await save('whole', 'other', owner)).statusCode, 409);
  assert.equal((await app.inject({ method: 'GET', url, headers })).json().mode, 'record');
});

test('rejects missing/foreign identity and invalid preference without writing', async () => {
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
  assert.equal((await save('record', 'guest')).statusCode, 403);
  assert.equal((await save('guess')).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url, headers, payload: { mode: 'record' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url, headers })).json().mode, 'whole');
});

test('unreadable preferences remain intact and surface a retryable failure', async () => {
  await mkdir(join(projectRoot, '.cat-cafe'));
  const original = '{ interrupted write';
  await writeFile(preferencesPath(), original);
  assert.equal((await app.inject({ method: 'GET', url, headers })).statusCode, 503);
  assert.equal((await save('record')).statusCode, 503);
  assert.equal(await readFile(preferencesPath(), 'utf8'), original);
});
