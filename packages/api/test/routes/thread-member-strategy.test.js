import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import Fastify from 'fastify';
import { threadMemberStrategyRoutes } from '../../dist/routes/thread-member-strategy.js';

const HEADERS = { 'x-cat-cafe-user': 'test-user', 'content-type': 'application/json' };
const THREAD_ID = 'thread-001';
const CAT_ID = 'opus';

/**
 * In-memory mock threadStore that satisfies ThreadMemberStrategyRouteOptions.
 */
function createMockThreadStore() {
  const threads = new Map();
  const strategies = new Map();

  return {
    get(id) {
      return threads.get(id) ?? null;
    },
    updateMemberSessionStrategy(threadId, catId, strategy) {
      const key = `${threadId}:${catId}`;
      if (strategy === null) {
        strategies.delete(key);
      } else {
        strategies.set(key, strategy);
      }
    },
    getMemberSessionStrategy(threadId, catId, _userId) {
      return strategies.get(`${threadId}:${catId}`);
    },
    // Test helpers
    _addThread(id, createdBy = 'test-user') {
      threads.set(id, { id, createdBy });
    },
    _clear() {
      threads.clear();
      strategies.clear();
    },
  };
}

function buildApp(threadStore) {
  const app = Fastify();
  app.register(threadMemberStrategyRoutes, { threadStore });
  return app;
}

describe('thread-member-strategy routes (#921)', () => {
  let app;
  let threadStore;

  beforeEach(() => {
    threadStore = createMockThreadStore();
    threadStore._addThread(THREAD_ID);
    app = buildApp(threadStore);
  });

  afterEach(async () => {
    await app.close();
    threadStore._clear();
  });

  it('GET returns default strategy "resume" when none set', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/threads/${THREAD_ID}/members/${CAT_ID}/session-strategy`,
      headers: HEADERS,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.strategy, 'resume');
    assert.equal(body.threadId, THREAD_ID);
    assert.equal(body.catId, CAT_ID);
  });

  it('PATCH sets strategy to "reborn", subsequent GET returns "reborn"', async () => {
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${THREAD_ID}/members/${CAT_ID}/session-strategy`,
      headers: HEADERS,
      payload: { strategy: 'reborn' },
    });
    assert.equal(patchRes.statusCode, 200);
    const patchBody = JSON.parse(patchRes.payload);
    assert.equal(patchBody.ok, true);
    assert.equal(patchBody.strategy, 'reborn');

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/threads/${THREAD_ID}/members/${CAT_ID}/session-strategy`,
      headers: HEADERS,
    });
    assert.equal(getRes.statusCode, 200);
    const getBody = JSON.parse(getRes.payload);
    assert.equal(getBody.strategy, 'reborn');
  });

  it('PATCH with null clears strategy back to "resume"', async () => {
    // Set to reborn first
    await app.inject({
      method: 'PATCH',
      url: `/api/threads/${THREAD_ID}/members/${CAT_ID}/session-strategy`,
      headers: HEADERS,
      payload: { strategy: 'reborn' },
    });

    // Clear with null
    const clearRes = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${THREAD_ID}/members/${CAT_ID}/session-strategy`,
      headers: HEADERS,
      payload: { strategy: null },
    });
    assert.equal(clearRes.statusCode, 200);
    const clearBody = JSON.parse(clearRes.payload);
    assert.equal(clearBody.ok, true);
    assert.equal(clearBody.strategy, 'resume');

    // Confirm GET also returns resume
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/threads/${THREAD_ID}/members/${CAT_ID}/session-strategy`,
      headers: HEADERS,
    });
    assert.equal(getRes.statusCode, 200);
    const getBody = JSON.parse(getRes.payload);
    assert.equal(getBody.strategy, 'resume');
  });

  it('PATCH rejects invalid strategy value (returns 400)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${THREAD_ID}/members/${CAT_ID}/session-strategy`,
      headers: HEADERS,
      payload: { strategy: 'invalid-strategy' },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.payload);
    assert.ok(body.error);
  });

  it('GET returns 404 for non-existent thread', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/threads/no-such-thread/members/${CAT_ID}/session-strategy`,
      headers: HEADERS,
    });
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.payload);
    assert.ok(body.error.includes('not found') || body.error.includes('Thread'));
  });

  it('GET returns 401 without identity header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/threads/${THREAD_ID}/members/${CAT_ID}/session-strategy`,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.payload);
    assert.ok(body.error);
  });

  it('GET returns 403 when user does not own the thread', async () => {
    threadStore._addThread('other-thread', 'someone-else');
    const res = await app.inject({
      method: 'GET',
      url: `/api/threads/other-thread/members/${CAT_ID}/session-strategy`,
      headers: HEADERS,
    });
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.payload);
    assert.ok(body.error.includes('Access denied'));
  });

  it('PATCH returns 403 when user does not own the thread', async () => {
    threadStore._addThread('other-thread', 'someone-else');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/other-thread/members/${CAT_ID}/session-strategy`,
      headers: HEADERS,
      payload: { strategy: 'reborn' },
    });
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.payload);
    assert.ok(body.error.includes('Access denied'));
  });

  it('PATCH returns 400 on the shared default thread (strategy is not user-scoped)', async () => {
    threadStore._addThread('default', 'system');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/default/members/${CAT_ID}/session-strategy`,
      headers: HEADERS,
      payload: { strategy: 'reborn' },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.payload);
    assert.ok(body.error.includes('shared default thread'));
  });

  it('GET returns 400 on the shared default thread (triggers UI self-hide)', async () => {
    threadStore._addThread('default', 'system');
    const res = await app.inject({
      method: 'GET',
      url: `/api/threads/default/members/${CAT_ID}/session-strategy`,
      headers: HEADERS,
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.payload);
    assert.ok(body.error.includes('shared default thread'));
  });
});
