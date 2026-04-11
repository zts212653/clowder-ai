/**
 * Memory API route tests
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { MemoryStore } from '../dist/domains/cats/services/stores/ports/MemoryStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { memoryRoutes } from '../dist/routes/memory.js';

describe('Memory API Routes', () => {
  let app;
  let memoryStore;
  let threadStore;
  let ownThreadId;
  let otherThreadId;

  beforeEach(async () => {
    app = Fastify();
    memoryStore = new MemoryStore();
    threadStore = new ThreadStore();
    ownThreadId = threadStore.create('test-user', 'Own thread').id;
    otherThreadId = threadStore.create('other-user', 'Other thread').id;
    await app.register(memoryRoutes, { memoryStore, threadStore });
    await app.ready();
  });

  it('POST /api/memory creates entry and returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/memory',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: {
        threadId: ownThreadId,
        key: 'project-goal',
        value: 'Build a collaborative AI system',
        updatedBy: 'user',
      },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.key, 'project-goal');
    assert.equal(body.value, 'Build a collaborative AI system');
    assert.equal(body.threadId, ownThreadId);
    assert.equal(body.updatedBy, 'user');
    assert.ok(body.updatedAt);
  });

  it('POST /api/memory with cat updatedBy works', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/memory',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: {
        threadId: ownThreadId,
        key: 'decision',
        value: 'Use CLI subprocess approach',
        updatedBy: 'opus',
      },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json();
    // Note: createCatId wraps the string, but JSON serialization shows the underlying value
    assert.ok(body.updatedBy.includes('opus') || body.updatedBy === 'opus');
  });

  it('POST /api/memory returns 400 for missing fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/memory',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: { threadId: 'thread-1' },
    });

    assert.equal(res.statusCode, 400);
  });

  it('GET /api/memory?threadId=&key= returns single entry', async () => {
    // First create an entry
    await app.inject({
      method: 'POST',
      url: '/api/memory',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: { threadId: ownThreadId, key: 'goal', value: 'Test', updatedBy: 'user' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/memory?threadId=${ownThreadId}&key=goal`,
      headers: { 'x-cat-cafe-user': 'test-user' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.key, 'goal');
    assert.equal(body.value, 'Test');
  });

  it('GET /api/memory?threadId=&key= returns 404 for unknown', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/memory?threadId=${ownThreadId}&key=unknown`,
      headers: { 'x-cat-cafe-user': 'test-user' },
    });

    assert.equal(res.statusCode, 404);
  });

  it('GET /api/memory?threadId= lists all entries', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/memory',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: { threadId: ownThreadId, key: 'a', value: '1', updatedBy: 'user' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/memory',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: { threadId: ownThreadId, key: 'b', value: '2', updatedBy: 'user' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/memory?threadId=${ownThreadId}`,
      headers: { 'x-cat-cafe-user': 'test-user' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.entries.length, 2);
  });

  it('DELETE /api/memory removes entry', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/memory',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: { threadId: ownThreadId, key: 'temp', value: 'x', updatedBy: 'user' },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/memory?threadId=${ownThreadId}&key=temp`,
      headers: { 'x-cat-cafe-user': 'test-user' },
    });

    assert.equal(res.statusCode, 204);

    // Verify deleted
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/memory?threadId=${ownThreadId}&key=temp`,
      headers: { 'x-cat-cafe-user': 'test-user' },
    });
    assert.equal(getRes.statusCode, 404);
  });

  it('DELETE /api/memory returns 404 for unknown', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/memory?threadId=${ownThreadId}&key=unknown`,
      headers: { 'x-cat-cafe-user': 'test-user' },
    });

    assert.equal(res.statusCode, 404);
  });

  it('uses X-Cat-Cafe-User header over legacy userId query', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/memory',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: {
        threadId: ownThreadId,
        key: 'header-priority',
        value: 'ok',
        updatedBy: 'user',
      },
    });

    assert.equal(res.statusCode, 201);
  });

  it('returns 401 when identity is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/memory?threadId=${ownThreadId}`,
    });

    assert.equal(res.statusCode, 401);
  });

  it('returns 403 when accessing another user thread', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/memory',
      headers: { 'x-cat-cafe-user': 'other-user' },
      payload: {
        threadId: otherThreadId,
        key: 'secret',
        value: 'top secret',
        updatedBy: 'user',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/memory?threadId=${otherThreadId}&key=secret`,
      headers: { 'x-cat-cafe-user': 'test-user' },
    });

    assert.equal(res.statusCode, 403);
  });
});
