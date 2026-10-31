/**
 * Summaries Route Tests (拍立得照片墙)
 * Uses lightweight Fastify injection (no real HTTP server).
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

function createMockSocketManager() {
  const events = [];
  return {
    broadcastToRoom(room, event, data) {
      events.push({ room, event, data });
    },
    getEvents() {
      return events;
    },
  };
}

describe('Summaries Routes', () => {
  let summaryStore;
  let socketManager;

  beforeEach(async () => {
    const { SummaryStore } = await import('../dist/domains/cats/services/stores/ports/SummaryStore.js');
    summaryStore = new SummaryStore();
    socketManager = createMockSocketManager();
  });

  async function createApp() {
    const { summariesRoutes } = await import('../dist/routes/summaries.js');
    const app = Fastify();
    await app.register(summariesRoutes, { summaryStore, socketManager });
    return app;
  }

  const validPayload = {
    threadId: 'thread-1',
    topic: 'AgentRouter 重构讨论',
    conclusions: ['拆分 invoke-single-cat', '并行用 mergeStreams'],
    openQuestions: ['需要进程池吗？'],
    createdBy: 'opus',
  };

  // ---- POST /api/summaries ----

  test('POST creates summary and returns 201', async () => {
    const app = await createApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/summaries',
      payload: validPayload,
    });

    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.ok(body.id);
    assert.equal(body.topic, 'AgentRouter 重构讨论');
    assert.equal(body.conclusions.length, 2);
  });

  test('POST does NOT broadcast thread_summary (clowder-ai#343)', async () => {
    const app = await createApp();
    await app.inject({
      method: 'POST',
      url: '/api/summaries',
      payload: validPayload,
    });

    const events = socketManager.getEvents();
    assert.equal(events.length, 0, 'summary should not be broadcast to chat flow');
  });

  test('POST rejects missing conclusions', async () => {
    const app = await createApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/summaries',
      payload: { threadId: 'thread-1', topic: 'Test', createdBy: 'opus' },
    });

    assert.equal(response.statusCode, 400);
  });

  test('POST rejects empty conclusions array', async () => {
    const app = await createApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/summaries',
      payload: { ...validPayload, conclusions: [] },
    });

    assert.equal(response.statusCode, 400);
  });

  // ---- GET /api/summaries?threadId ----

  test('GET lists summaries for a thread', async () => {
    const app = await createApp();
    await app.inject({ method: 'POST', url: '/api/summaries', payload: validPayload });
    await app.inject({
      method: 'POST',
      url: '/api/summaries',
      payload: { ...validPayload, topic: 'Second topic' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/summaries?threadId=thread-1',
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().summaries.length, 2);
  });

  test('GET requires threadId', async () => {
    const app = await createApp();
    const response = await app.inject({ method: 'GET', url: '/api/summaries' });
    assert.equal(response.statusCode, 400);
  });

  // ---- GET /api/summaries/:id ----

  test('GET by id returns summary', async () => {
    const app = await createApp();
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/summaries',
      payload: validPayload,
    });
    const id = createRes.json().id;

    const response = await app.inject({ method: 'GET', url: `/api/summaries/${id}` });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().topic, 'AgentRouter 重构讨论');
  });

  test('GET by id returns 404', async () => {
    const app = await createApp();
    const response = await app.inject({ method: 'GET', url: '/api/summaries/nonexistent' });
    assert.equal(response.statusCode, 404);
  });

  // ---- DELETE /api/summaries/:id ----

  test('DELETE removes summary and returns 204', async () => {
    const app = await createApp();
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/summaries',
      payload: validPayload,
    });
    const id = createRes.json().id;

    const response = await app.inject({ method: 'DELETE', url: `/api/summaries/${id}` });
    assert.equal(response.statusCode, 204);

    const getRes = await app.inject({ method: 'GET', url: `/api/summaries/${id}` });
    assert.equal(getRes.statusCode, 404);
  });

  test('DELETE returns 404 for nonexistent', async () => {
    const app = await createApp();
    const response = await app.inject({ method: 'DELETE', url: '/api/summaries/nonexistent' });
    assert.equal(response.statusCode, 404);
  });
});
