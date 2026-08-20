import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { threadMemberSpeedRoutes } from '../../dist/routes/thread-member-speed.js';

const HEADERS = { 'x-cat-cafe-user': 'test-user', 'content-type': 'application/json' };
const THREAD_ID = 'thread-speed-001';

function registerCodexSpeedCat(id, model, serviceTier) {
  if (catRegistry.has(id)) return;
  const base = catRegistry.getOrThrow('codex').config;
  catRegistry.register(id, {
    ...base,
    id: createCatId(id),
    displayName: id,
    accountRef: 'codex',
    defaultModel: model,
    cli: {
      ...base.cli,
      ...(serviceTier ? { serviceTier } : {}),
    },
  });
}

registerCodexSpeedCat('codex-speed-test', 'gpt-5.6-sol', 'standard');
registerCodexSpeedCat('codex-speed-old', 'gpt-4.1');

function createMockThreadStore() {
  const threads = new Map();
  const speeds = new Map();
  let bulkReads = 0;

  return {
    get(id) {
      return threads.get(id) ?? null;
    },
    updateMemberSpeed(threadId, catId, speed) {
      const key = `${threadId}:${catId}`;
      if (speed === null) speeds.delete(key);
      else speeds.set(key, speed);
    },
    getMemberSpeeds(threadId, _userId) {
      bulkReads += 1;
      return Object.fromEntries(
        [...speeds.entries()]
          .filter(([key]) => key.startsWith(`${threadId}:`))
          .map(([key, value]) => [key.slice(threadId.length + 1), value]),
      );
    },
    _addThread(id, createdBy = 'test-user', participants = []) {
      threads.set(id, { id, createdBy, participants });
    },
    _setSpeed(threadId, catId, speed) {
      speeds.set(`${threadId}:${catId}`, speed);
    },
    _bulkReads() {
      return bulkReads;
    },
  };
}

function buildApp(threadStore) {
  const app = Fastify();
  app.register(threadMemberSpeedRoutes, { threadStore });
  return app;
}

describe('F291 thread member speed routes', () => {
  let app;
  let threadStore;

  beforeEach(() => {
    threadStore = createMockThreadStore();
    threadStore._addThread(THREAD_ID, 'test-user', ['codex-speed-test', 'opus']);
    app = buildApp(threadStore);
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET returns participant-first OAuth Codex rows and labels requested source without claiming actual service', async () => {
    threadStore._setSpeed(THREAD_ID, 'codex-speed-test', 'fast');
    threadStore._setSpeed(THREAD_ID, 'codex-speed-old', 'fast');

    const res = await app.inject({ method: 'GET', url: `/api/threads/${THREAD_ID}/members/speed`, headers: HEADERS });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.threadId, THREAD_ID);
    assert.equal(threadStore._bulkReads(), 1);

    const supported = body.members.find((row) => row.catId === 'codex-speed-test');
    assert.ok(supported);
    assert.equal(supported.isParticipant, true);
    assert.equal(supported.override, 'fast');
    assert.equal(supported.inherited, 'standard');
    assert.equal(supported.requested, 'fast');
    assert.equal(supported.source, 'thread_override');
    assert.deepEqual(supported.options, ['standard', 'fast']);
    assert.equal('actual' in supported, false);
    assert.equal('effective' in supported, false);

    const stale = body.members.find((row) => row.catId === 'codex-speed-old');
    assert.ok(stale);
    assert.equal(stale.override, 'fast');
    assert.equal(stale.compatibility, 'incompatible');
    assert.equal(stale.requested, null);
    assert.deepEqual(stale.options, ['standard']);

    assert.equal(
      body.members.some((row) => row.catId === 'opus'),
      false,
    );
  });

  it('PATCH writes Standard/Fast and null clears to the member default', async () => {
    const setRes = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${THREAD_ID}/members/codex-speed-test/speed`,
      headers: HEADERS,
      payload: { speed: 'fast' },
    });
    assert.equal(setRes.statusCode, 200);
    assert.equal(JSON.parse(setRes.payload).requested, 'fast');

    const clearRes = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${THREAD_ID}/members/codex-speed-test/speed`,
      headers: HEADERS,
      payload: { speed: null },
    });
    assert.equal(clearRes.statusCode, 200);
    const cleared = JSON.parse(clearRes.payload);
    assert.equal(cleared.override, null);
    assert.equal(cleared.requested, 'standard');
    assert.equal(cleared.source, 'member_default');
  });

  it('rejects invalid, unsupported, shared-default, missing, foreign, and unauthenticated requests', async () => {
    const invalid = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${THREAD_ID}/members/codex-speed-test/speed`,
      headers: HEADERS,
      payload: { speed: 'turbo' },
    });
    assert.equal(invalid.statusCode, 400);

    const unsupported = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${THREAD_ID}/members/codex-speed-old/speed`,
      headers: HEADERS,
      payload: { speed: 'fast' },
    });
    assert.equal(unsupported.statusCode, 400);

    const nonCodex = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${THREAD_ID}/members/opus/speed`,
      headers: HEADERS,
      payload: { speed: 'standard' },
    });
    assert.equal(nonCodex.statusCode, 400);

    threadStore._addThread('default', 'system');
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/threads/default/members/speed', headers: HEADERS })).statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/threads/missing/members/speed', headers: HEADERS })).statusCode,
      404,
    );
    threadStore._addThread('foreign', 'other-user');
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/threads/foreign/members/speed', headers: HEADERS })).statusCode,
      403,
    );
    assert.equal((await app.inject({ method: 'GET', url: `/api/threads/${THREAD_ID}/members/speed` })).statusCode, 401);
  });
});
