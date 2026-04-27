/**
 * F174 Phase D1 — end-to-end wiring: every 401 from real routes must
 * increment the telemetry snapshot. Validates AC-D2 (all 5 reasons covered)
 * by hitting routes through Fastify and asserting reasonCounts.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { createTestContext } from './helpers/refresh-token-test-app.js';

describe('callback-auth-telemetry integration (F174-D1)', () => {
  let getCallbackAuthFailureSnapshot;
  let resetCallbackAuthFailureForTest;

  beforeEach(async () => {
    const mod = await import('../dist/routes/callback-auth-telemetry.js');
    getCallbackAuthFailureSnapshot = mod.getCallbackAuthFailureSnapshot;
    resetCallbackAuthFailureForTest = mod.resetCallbackAuthFailureForTest;
    resetCallbackAuthFailureForTest();
  });

  test('refresh-token missing_creds increments counter (AC-D2)', async () => {
    const { createApp } = await createTestContext();
    const app = await createApp();
    const res = await app.inject({ method: 'POST', url: '/api/callbacks/refresh-token' });
    assert.equal(res.statusCode, 401);
    const snap = getCallbackAuthFailureSnapshot();
    assert.equal(snap.reasonCounts.missing_creds, 1);
    assert.equal(snap.toolCounts['refresh-token'], 1);
  });

  test('refresh-token invalid_token increments counter (AC-D2)', async () => {
    const { registry, createApp } = await createTestContext();
    const app = await createApp();
    const { invocationId } = await registry.create('user-1', 'opus', 'thread-1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': 'wrong' },
    });
    assert.equal(res.statusCode, 401);
    const snap = getCallbackAuthFailureSnapshot();
    assert.equal(snap.reasonCounts.invalid_token, 1);
  });

  test('refresh-token unknown_invocation increments counter (AC-D2)', async () => {
    const { createApp } = await createTestContext();
    const app = await createApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': 'never-existed', 'x-callback-token': 'any' },
    });
    assert.equal(res.statusCode, 401);
    const snap = getCallbackAuthFailureSnapshot();
    assert.equal(snap.reasonCounts.unknown_invocation, 1);
  });

  test('refresh-token expired increments counter (AC-D2)', async () => {
    // Build a context with a short-TTL registry so we can exercise the
    // expired path quickly.
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const Fastify = (await import('fastify')).default;
    const registry = new InvocationRegistry({ ttlMs: 5 });

    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore: new MessageStore(),
      threadStore: new ThreadStore(),
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
      evidenceStore: {
        search: async () => [],
        health: async () => true,
        initialize: async () => {},
        upsert: async () => {},
        deleteByAnchor: async () => {},
        getByAnchor: async () => null,
      },
      reflectionService: { reflect: async () => '' },
      markerQueue: {
        submit: async (m) => ({ id: 'mk-1', createdAt: new Date().toISOString(), ...m }),
        list: async () => [],
        transition: async () => {},
      },
    });

    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');
    await new Promise((r) => setTimeout(r, 30)); // past 5ms TTL

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });
    assert.equal(res.statusCode, 401);
    const snap = getCallbackAuthFailureSnapshot();
    assert.equal(snap.reasonCounts.expired, 1, 'expired path must increment counter');
  });

  test('refresh-token stale_invocation increments counter (AC-D2)', async () => {
    const { registry, createApp } = await createTestContext();
    const app = await createApp();
    const old = await registry.create('user-1', 'opus', 'thread-1');
    await registry.create('user-1', 'opus', 'thread-1'); // supersedes old
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': old.invocationId, 'x-callback-token': old.callbackToken },
    });
    assert.equal(res.statusCode, 401);
    const snap = getCallbackAuthFailureSnapshot();
    assert.equal(snap.reasonCounts.stale_invocation, 1);
  });
});
