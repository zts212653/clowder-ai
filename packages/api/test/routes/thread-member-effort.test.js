import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { threadMemberEffortRoutes } from '../../dist/routes/thread-member-effort.js';

const HEADERS = { 'x-cat-cafe-user': 'test-user', 'content-type': 'application/json' };
const THREAD_ID = 'thread-effort-001';

if (!catRegistry.has('codex-sol')) {
  const base = catRegistry.getOrThrow('codex').config;
  catRegistry.register('codex-sol', {
    ...base,
    id: createCatId('codex-sol'),
    displayName: 'Sol',
    defaultModel: 'gpt-5.6-sol',
  });
}

function createMockThreadStore() {
  const threads = new Map();
  const efforts = new Map();
  let bulkReads = 0;

  return {
    get(id) {
      return threads.get(id) ?? null;
    },
    updateMemberEffort(threadId, catId, effort) {
      const key = `${threadId}:${catId}`;
      if (effort === null) efforts.delete(key);
      else efforts.set(key, effort);
    },
    getMemberEffort(threadId, catId, _userId) {
      return efforts.get(`${threadId}:${catId}`);
    },
    getMemberEfforts(threadId, _userId) {
      bulkReads += 1;
      return Object.fromEntries(
        [...efforts.entries()]
          .filter(([key]) => key.startsWith(`${threadId}:`))
          .map(([key, value]) => [key.slice(threadId.length + 1), value]),
      );
    },
    _addThread(id, createdBy = 'test-user', participants = []) {
      threads.set(id, { id, createdBy, participants });
    },
    _setEffort(threadId, catId, effort) {
      efforts.set(`${threadId}:${catId}`, effort);
    },
    _bulkReads() {
      return bulkReads;
    },
  };
}

function buildApp(threadStore) {
  const app = Fastify();
  app.register(threadMemberEffortRoutes, { threadStore });
  return app;
}

describe('F262 thread member effort routes', () => {
  let app;
  let threadStore;

  beforeEach(() => {
    threadStore = createMockThreadStore();
    threadStore._addThread(THREAD_ID, 'test-user', ['codex-sol', 'opus']);
    app = buildApp(threadStore);
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET returns participant-first effort-capable rows from one bulk read', async () => {
    threadStore._setEffort(THREAD_ID, 'codex-sol', 'max');
    threadStore._setEffort(THREAD_ID, 'codex', 'ultra');

    const res = await app.inject({ method: 'GET', url: `/api/threads/${THREAD_ID}/members/effort`, headers: HEADERS });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.threadId, THREAD_ID);
    assert.equal(threadStore._bulkReads(), 1);

    const sol = body.members.find((row) => row.catId === 'codex-sol');
    assert.ok(sol);
    assert.equal(sol.isParticipant, true);
    assert.equal(sol.override, 'max');
    assert.equal(sol.effective, 'max');
    assert.equal(sol.source, 'thread_override');
    assert.ok(sol.options.includes('ultra'));

    const stale = body.members.find((row) => row.catId === 'codex');
    assert.ok(stale);
    assert.equal(stale.override, 'ultra');
    assert.equal(stale.compatibility, 'incompatible');
    assert.equal(stale.source, 'inherited');
    assert.notEqual(stale.effective, 'ultra');

    assert.equal(
      body.members.some((row) => row.catId === 'gemini'),
      false,
    );
    const firstNonParticipant = body.members.findIndex((row) => !row.isParticipant);
    assert.ok(firstNonParticipant >= 0);
    assert.ok(body.members.slice(0, firstNonParticipant).every((row) => row.isParticipant));
  });

  it('PATCH writes a valid override and null clears back to inheritance', async () => {
    const setRes = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${THREAD_ID}/members/codex-sol/effort`,
      headers: HEADERS,
      payload: { effort: 'ultra' },
    });
    assert.equal(setRes.statusCode, 200);
    assert.equal(JSON.parse(setRes.payload).effective, 'ultra');

    const clearRes = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${THREAD_ID}/members/codex-sol/effort`,
      headers: HEADERS,
      payload: { effort: null },
    });
    assert.equal(clearRes.statusCode, 200);
    const cleared = JSON.parse(clearRes.payload);
    assert.equal(cleared.override, null);
    assert.equal(cleared.source, 'inherited');
    assert.equal(cleared.effective, cleared.inherited);
    assert.equal(cleared.compatibility, 'compatible');
  });

  it('projects options and validates overrides against the runtime-effective model', async () => {
    const previousCodexModel = process.env.CAT_CODEX_MODEL;
    const previousSolModel = process.env.CAT_CODEX_SOL_MODEL;
    try {
      process.env.CAT_CODEX_MODEL = 'gpt-5.6-sol';
      const upgraded = await app.inject({
        method: 'PATCH',
        url: `/api/threads/${THREAD_ID}/members/codex/effort`,
        headers: HEADERS,
        payload: { effort: 'ultra' },
      });
      assert.equal(upgraded.statusCode, 200);
      assert.ok(JSON.parse(upgraded.payload).options.includes('ultra'));

      process.env.CAT_CODEX_SOL_MODEL = 'gpt-5.4';
      threadStore._setEffort(THREAD_ID, 'codex-sol', 'ultra');
      const downgraded = await app.inject({
        method: 'GET',
        url: `/api/threads/${THREAD_ID}/members/effort`,
        headers: HEADERS,
      });
      assert.equal(downgraded.statusCode, 200);
      const sol = JSON.parse(downgraded.payload).members.find((row) => row.catId === 'codex-sol');
      assert.ok(sol);
      assert.equal(sol.compatibility, 'incompatible');
      assert.equal(sol.options.includes('ultra'), false);

      const rejected = await app.inject({
        method: 'PATCH',
        url: `/api/threads/${THREAD_ID}/members/codex-sol/effort`,
        headers: HEADERS,
        payload: { effort: 'ultra' },
      });
      assert.equal(rejected.statusCode, 400);
    } finally {
      if (previousCodexModel === undefined) delete process.env.CAT_CODEX_MODEL;
      else process.env.CAT_CODEX_MODEL = previousCodexModel;
      if (previousSolModel === undefined) delete process.env.CAT_CODEX_SOL_MODEL;
      else process.env.CAT_CODEX_SOL_MODEL = previousSolModel;
    }
  });

  it('rejects invalid, unsupported, shared-default, missing, and foreign requests', async () => {
    const invalid = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${THREAD_ID}/members/codex/effort`,
      headers: HEADERS,
      payload: { effort: 'ultra' },
    });
    assert.equal(invalid.statusCode, 400);

    const unsupported = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${THREAD_ID}/members/gemini/effort`,
      headers: HEADERS,
      payload: { effort: 'high' },
    });
    assert.equal(unsupported.statusCode, 400);

    threadStore._addThread('default', 'system');
    const shared = await app.inject({ method: 'GET', url: '/api/threads/default/members/effort', headers: HEADERS });
    assert.equal(shared.statusCode, 400);

    const missing = await app.inject({ method: 'GET', url: '/api/threads/missing/members/effort', headers: HEADERS });
    assert.equal(missing.statusCode, 404);

    threadStore._addThread('foreign', 'other-user');
    const foreign = await app.inject({ method: 'GET', url: '/api/threads/foreign/members/effort', headers: HEADERS });
    assert.equal(foreign.statusCode, 403);

    const unauth = await app.inject({ method: 'GET', url: `/api/threads/${THREAD_ID}/members/effort` });
    assert.equal(unauth.statusCode, 401);
  });
});
