import assert from 'node:assert/strict';
import { test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { ConciergeKeys } from '../src/domains/concierge/concierge-keys.js';
import { CompanionBridgeError, CompanionOwnerClient } from '../src/domains/concierge/live/companion-owner-client.js';
import {
  COMPANION_SCENE_MAX_BYTES,
  companionSceneSnapshotError,
} from '../src/domains/concierge/scene/companion-scene-snapshot.js';
import {
  type ICompanionSceneStore,
  MemoryCompanionSceneStore,
} from '../src/domains/concierge/scene/companion-scene-store.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { registerConciergeCompanionSceneRoutes } from '../src/routes/concierge-companion-scene.js';

// F336 Phase C U1: the owner-only HTTP face of the scene archive, and the in-process client the Host uses.
const owner = 'default-user';
const origin = 'http://localhost:3011';
const url = '/api/concierge/companion-scene?catId=opus&sceneId=desktop';
const snapshot = { schemaVersion: 1, pose: { name: 'loaf', x: 1, y: 2 }, hat: { tilt: 0.25 } };

async function fixture(t: import('node:test').TestContext, store?: ICompanionSceneStore) {
  const entries = new Map<string, string>();
  const app = Fastify();
  t.after(() => app.close());
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute);
  registerConciergeCompanionSceneRoutes(app, {
    store: store ?? new MemoryCompanionSceneStore({ entries, now: () => 1000 }),
  });
  const login = await app.inject({ method: 'GET', url: '/api/session' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] ?? '', origin };
  return { app, entries, headers };
}

test('only an owner session on the local origin reads or writes a scene', async (t) => {
  const { app, entries, headers } = await fixture(t);
  const anonymous = await app.inject({ method: 'GET', url, headers: { 'x-cat-cafe-user': owner } });
  assert.equal(anonymous.statusCode, 401);
  const foreign = await app.inject({
    method: 'PUT',
    url,
    headers: { ...headers, origin: 'https://foreign.invalid' },
    payload: { baseRevision: 0, snapshot },
  });
  assert.equal(foreign.statusCode, 403);
  assert.equal(entries.size, 0);
});

test('read is tri-state and writes are compare-and-swap on revision', async (t) => {
  const { app, headers } = await fixture(t);
  const empty = await app.inject({ method: 'GET', url, headers });
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.headers['cache-control'], 'no-store');
  assert.deepEqual(empty.json(), { status: 'not_found' });

  const created = await app.inject({ method: 'PUT', url, headers, payload: { baseRevision: 0, snapshot } });
  assert.equal(created.statusCode, 200);
  assert.deepEqual(created.json(), { status: 'ok', revision: 1 });
  const found = await app.inject({ method: 'GET', url, headers });
  assert.deepEqual(found.json(), { status: 'found', revision: 1, updatedAt: 1000, snapshot });

  const stale = await app.inject({
    method: 'PUT',
    url,
    headers,
    payload: { baseRevision: 0, snapshot: { schemaVersion: 1, lastSolo: 'nap' } },
  });
  assert.equal(stale.statusCode, 409);
  assert.deepEqual(stale.json(), { status: 'conflict', current: found.json() });
});

test('a corrupt scene is a 503 error on read and a 409 on every write; the stored value is kept', async (t) => {
  const { app, entries, headers } = await fixture(t);
  const key = ConciergeKeys.companionScene(owner, 'opus', 'desktop');
  entries.set(key, '{"revision":4,');
  const read = await app.inject({ method: 'GET', url, headers });
  assert.equal(read.statusCode, 503);
  assert.deepEqual(read.json(), { status: 'error', reason: 'corrupt' });
  const write = await app.inject({ method: 'PUT', url, headers, payload: { baseRevision: 0, snapshot } });
  assert.equal(write.statusCode, 409);
  assert.deepEqual(write.json(), { status: 'conflict', current: { status: 'error', reason: 'corrupt' } });
  assert.equal(entries.get(key), '{"revision":4,');
});

test('a store outage is a 503 error on both read and write', async (t) => {
  const down: ICompanionSceneStore = {
    get: async () => ({ status: 'error', reason: 'unavailable' }),
    put: async () => ({ status: 'error', reason: 'unavailable' }),
  };
  const { app, headers } = await fixture(t, down);
  const read = await app.inject({ method: 'GET', url, headers });
  assert.equal(read.statusCode, 503);
  assert.deepEqual(read.json(), { status: 'error', reason: 'unavailable' });
  const write = await app.inject({ method: 'PUT', url, headers, payload: { baseRevision: 0, snapshot } });
  assert.equal(write.statusCode, 503);
  assert.deepEqual(write.json(), { status: 'error', reason: 'unavailable' });
});

test('invalid addresses and snapshots are rejected with 400 before the store is touched', async (t) => {
  const { app, entries, headers } = await fixture(t);
  const badAddresses = [
    '/api/concierge/companion-scene?sceneId=desktop',
    '/api/concierge/companion-scene?catId=opus',
    '/api/concierge/companion-scene?catId=opus&sceneId=garden',
    '/api/concierge/companion-scene?catId=op%3Aus&sceneId=desktop',
    '/api/concierge/companion-scene?catId=opus&sceneId=desktop&userId=other',
  ];
  for (const address of badAddresses) {
    assert.equal((await app.inject({ method: 'GET', url: address, headers })).statusCode, 400, address);
    const put = await app.inject({ method: 'PUT', url: address, headers, payload: { baseRevision: 0, snapshot } });
    assert.equal(put.statusCode, 400, address);
  }
  const badBodies = [
    { snapshot },
    { baseRevision: -1, snapshot },
    { baseRevision: 1.5, snapshot },
    { baseRevision: '0', snapshot },
    { baseRevision: 0, snapshot, extra: true },
    { baseRevision: 0 },
    { baseRevision: 0, snapshot: [] },
    { baseRevision: 0, snapshot: { pose: {} } },
    { baseRevision: 0, snapshot: { schemaVersion: 2 } },
    { baseRevision: 0, snapshot: { schemaVersion: 1, mood: 'sleepy' } },
    { baseRevision: 0, snapshot: { schemaVersion: 1, paper: 'x'.repeat(COMPANION_SCENE_MAX_BYTES) } },
  ];
  for (const payload of badBodies) {
    const response = await app.inject({ method: 'PUT', url, headers, payload });
    assert.equal(response.statusCode, 400, JSON.stringify(payload).slice(0, 80));
  }
  assert.equal(entries.size, 0);
});

test('the snapshot validator admits only bounded, finite, plain JSON under the known fields', () => {
  const nested = (depth: number): unknown => (depth === 0 ? 1 : { inner: nested(depth - 1) });
  assert.equal(companionSceneSnapshotError(snapshot), undefined);
  assert.equal(
    companionSceneSnapshotError({
      schemaVersion: 1,
      pose: {},
      ball: [],
      paper: null,
      hat: true,
      activity: 'groom',
      lastSolo: 3,
    }),
    undefined,
  );
  assert.equal(companionSceneSnapshotError({ schemaVersion: 1, pose: nested(7) }), undefined);
  for (const value of [
    null,
    'scene',
    { schemaVersion: 1, pose: { x: Number.NaN } },
    { schemaVersion: 1, pose: { x: Number.POSITIVE_INFINITY } },
    { schemaVersion: 1, pose: { at: new Date(0) } },
    { schemaVersion: 1, pose: { x: undefined } },
    { schemaVersion: 1, pose: nested(8) },
  ])
    assert.notEqual(companionSceneSnapshotError(value), undefined, String(value));
});

test('the owner client reads and writes scenes through the ordinary owner route', async (t) => {
  const { app, entries } = await fixture(t);
  let checks = 0;
  const client = new CompanionOwnerClient({
    app,
    ownerUserId: owner,
    origin,
    assertCurrent: async () => {
      checks++;
    },
  });
  assert.deepEqual(await client.readCompanionScene('opus', 'desktop'), { status: 'not_found' });
  assert.ok(checks >= 2);
  assert.deepEqual(await client.writeCompanionScene('opus', 'desktop', { baseRevision: 0, snapshot }), {
    status: 'ok',
    revision: 1,
  });
  const found = { status: 'found', revision: 1, updatedAt: 1000, snapshot };
  assert.deepEqual(await client.readCompanionScene('opus', 'desktop'), found);
  assert.deepEqual(await client.writeCompanionScene('opus', 'desktop', { baseRevision: 0, snapshot }), {
    status: 'conflict',
    current: found,
  });
  await assert.rejects(
    client.writeCompanionScene('opus', 'desktop', {
      baseRevision: 1,
      snapshot: { schemaVersion: 1, mood: 'sleepy' } as never,
    }),
    (error) => error instanceof CompanionBridgeError && error.code === 'invalid_request',
  );
  entries.set(ConciergeKeys.companionScene(owner, 'opus', 'desktop'), 'not json');
  assert.deepEqual(await client.readCompanionScene('opus', 'desktop'), { status: 'error', reason: 'corrupt' });
});
