import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

async function buildApp() {
  const { dutyBriefingRoutes } = await import('../dist/routes/duty-briefing.js');
  const { MemoryBriefingConfigStore } = await import(
    '../dist/domains/cats/services/duty-briefing/BriefingConfigStore.js'
  );

  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    const sessionUser = request.headers['x-test-session-user'];
    if (typeof sessionUser === 'string' && sessionUser.trim()) {
      request.sessionUserId = sessionUser.trim();
    }
  });

  await app.register(dutyBriefingRoutes, {
    configStore: new MemoryBriefingConfigStore(),
    messageStore: {
      append: async (msg) => ({ id: 'msg-1', ...msg }),
      getByThread: async () => [],
      getByThreadBefore: async () => [],
    },
    threadStore: { get: async () => null },
    collectDeps: {
      taskStore: { listByKind: async () => [] },
      invocationRecordStore: {},
      draftStore: { getByThread: async () => [] },
      dynamicTaskStore: { getAll: () => [] },
      threadStore: { list: async () => [] },
      messageStore: { getByThread: async () => [], getByThreadAfter: async () => [] },
      userId: 'default-user',
    },
  });
  await app.ready();
  return app;
}

describe('duty-briefing routes auth', () => {
  it('GET /api/duty-briefing/binding rejects when no authenticated session', async () => {
    const prev = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'owner-user';
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/duty-briefing/binding',
      });
      assert.equal(res.statusCode, 401);
      assert.match(JSON.parse(res.body).error, /session/i);
    } finally {
      if (prev === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prev;
      await app.close();
    }
  });

  it('GET /api/duty-briefing/binding rejects non-owner session when owner configured', async () => {
    const prev = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'owner-user';
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/duty-briefing/binding',
        headers: { 'x-test-session-user': 'not-owner' },
      });
      assert.equal(res.statusCode, 403);
      assert.match(JSON.parse(res.body).error, /configured owner/i);
    } finally {
      if (prev === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prev;
      await app.close();
    }
  });

  it('PUT /api/duty-briefing/binding rejects when no authenticated session', async () => {
    const prev = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'owner-user';
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/duty-briefing/binding',
        payload: { threadId: 'thr-x' },
      });
      assert.equal(res.statusCode, 401);
      assert.match(JSON.parse(res.body).error, /session/i);
    } finally {
      if (prev === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prev;
      await app.close();
    }
  });

  it('PUT /api/duty-briefing/binding rejects non-owner session when owner configured', async () => {
    const prev = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'owner-user';
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/duty-briefing/binding',
        headers: { 'x-test-session-user': 'not-owner' },
        payload: { threadId: 'thr-x' },
      });
      assert.equal(res.statusCode, 403);
      assert.match(JSON.parse(res.body).error, /configured owner/i);
    } finally {
      if (prev === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prev;
      await app.close();
    }
  });

  it('POST /api/duty-briefing/generate rejects header-only identity and allows owner session', async () => {
    const prev = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'owner-user';
    const app = await buildApp();
    try {
      const headerOnly = await app.inject({
        method: 'POST',
        url: '/api/duty-briefing/generate',
        headers: { 'x-cat-cafe-user': 'owner-user' },
        payload: {},
      });
      assert.equal(headerOnly.statusCode, 401);

      const owner = await app.inject({
        method: 'POST',
        url: '/api/duty-briefing/generate',
        headers: { 'x-test-session-user': 'owner-user' },
        payload: {},
      });
      assert.equal(owner.statusCode, 200);
      assert.equal(JSON.parse(owner.body).result.outcome, 'unbound');
    } finally {
      if (prev === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prev;
      await app.close();
    }
  });
});
