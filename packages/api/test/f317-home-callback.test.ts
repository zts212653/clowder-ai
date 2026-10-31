import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { f317HomeOwnerRoutes, f317LiveHomeRoutes } from '../src/routes/f317-home-actions.js';

test('callback requires verified invocation credentials and accepts no model target, value, URL or source', async () => {
  const registry = new InvocationRegistry();
  const credentials = await registry.create('owner', createCatId('codex61-sol'), 'current-call-thread');
  const headers = { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken };
  let calls = 0;
  const app = Fastify();
  await app.register(f317LiveHomeRoutes, {
    registry,
    service: {
      run: async (principal) => {
        assert.equal(principal.userId, 'owner');
        assert.equal(principal.threadId, 'current-call-thread');
        calls++;
        return { requestMessageId: 'owner-source', observedAtMs: Date.now(), status: 'unconfirmed' };
      },
    },
  });
  try {
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/callbacks/home-action', payload: {} })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/callbacks/home-action',
          headers: { ...headers, 'x-callback-token': 'wrong' },
          payload: {},
        })
      ).statusCode,
      401,
    );
    for (const payload of [
      { url: 'https://private.test' },
      { target: 'invented' },
      { value: 'send now' },
      { requestMessageId: 'older-owner' },
    ])
      assert.equal(
        (await app.inject({ method: 'POST', url: '/api/callbacks/home-action', headers, payload })).statusCode,
        400,
      );
    const valid = await app.inject({ method: 'POST', url: '/api/callbacks/home-action', headers, payload: {} });
    assert.equal(valid.statusCode, 200);
    assert.equal(valid.json().status, 'unconfirmed');
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
});

test('owner command consumption cannot use callback credentials as a browser owner session or change its target', async () => {
  let consumed = 0;
  const app = Fastify();
  await app.register(f317HomeOwnerRoutes, {
    ownerUserId: 'owner',
    service: {
      hub: {
        unregisterClient: () => false,
        registerClient: () => ({ clientToken: randomUUID(), expiresAt: Date.now() + 1_000 }),
        consume: async () => {
          consumed++;
          return { kind: 'blocked' };
        },
      },
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/api/concierge/home/commands/${randomUUID()}`,
      headers: { 'x-invocation-id': 'model', 'x-callback-token': 'token' },
      payload: { clientId: randomUUID() },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(consumed, 0);
  } finally {
    await app.close();
  }
});
