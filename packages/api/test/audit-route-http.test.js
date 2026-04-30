// @ts-check
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { auditRoutes } from '../dist/routes/audit.js';

function stubThreadStore(threads = {}) {
  return {
    get: async (id) => threads[id] ?? null,
    create: async () => ({}),
    list: async () => [],
    listByProject: async () => [],
    addParticipants: async () => {},
    getParticipants: async () => [],
    getParticipantsWithActivity: async () => [],
    updateParticipantActivity: async () => {},
  };
}

describe('audit route HTTP-level access control', () => {
  let app;

  afterEach(async () => {
    await app?.close();
  });

  async function buildApp(threads) {
    app = Fastify();
    await app.register(auditRoutes, { threadStore: stubThreadStore(threads) });
    await app.ready();
    return app;
  }

  it('returns 200 for owner accessing their own thread', async () => {
    await buildApp({ 'thread-123': { id: 'thread-123', createdBy: 'user-alice' } });
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit/thread/thread-123',
      headers: { 'x-cat-cafe-user': 'user-alice' },
    });
    assert.equal(res.statusCode, 200);
  });

  it('returns 200 for any user accessing the shared default thread', async () => {
    await buildApp({ default: { id: 'default', createdBy: 'system' } });
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit/thread/default',
      headers: { 'x-cat-cafe-user': 'user-bob' },
    });
    assert.equal(res.statusCode, 200);
  });

  it('returns 403 for non-default system-owned thread', async () => {
    await buildApp({ 'thread-sys': { id: 'thread-sys', createdBy: 'system' } });
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit/thread/thread-sys',
      headers: { 'x-cat-cafe-user': 'user-bob' },
    });
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'Access denied');
  });

  it('returns 403 for another user accessing someone else thread', async () => {
    await buildApp({ 'thread-456': { id: 'thread-456', createdBy: 'user-alice' } });
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit/thread/thread-456',
      headers: { 'x-cat-cafe-user': 'user-eve' },
    });
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'Access denied');
  });

  it('returns 404 for missing thread', async () => {
    await buildApp({});
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit/thread/nonexistent',
      headers: { 'x-cat-cafe-user': 'user-alice' },
    });
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'Thread not found');
  });
});
