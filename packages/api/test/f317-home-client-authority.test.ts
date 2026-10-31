import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { HomeHubDelivery } from '../src/domains/concierge/live/host/home/home-hub-delivery.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { f317HomeOwnerRoutes } from '../src/routes/f317-home-actions.js';

async function fixture(ownerUserId: string) {
  const app = Fastify();
  const hub = new HomeHubDelivery({
    messages: new MessageStore(),
    threads: new ThreadStore(),
    isCurrent: async () => true,
    emitter: { emit: () => {}, emitWithAck: async () => [] },
  });
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId });
  await app.register(f317HomeOwnerRoutes, { ownerUserId, service: { hub } });
  async function session(remoteAddress = '127.0.0.1') {
    const response = await app.inject({ method: 'GET', url: '/api/session', remoteAddress });
    assert.equal(response.statusCode, 200);
    return { cookie: `${response.cookies[0].name}=${response.cookies[0].value}` };
  }
  return { app, hub, session };
}

for (const ownerUserId of ['default-user', 'custom-owner']) {
  test(`remote non-owner sessions cannot consume ${ownerUserId}'s window capacity`, async () => {
    const f = await fixture(ownerUserId);
    try {
      const stranger = await f.session('192.0.2.12');
      const owner = await f.session();
      const statuses: number[] = [];
      for (let i = 0; i < 32; i++) {
        const response = await f.app.inject({
          method: 'POST',
          url: '/api/concierge/home/clients',
          headers: stranger,
          payload: { clientId: randomUUID() },
        });
        statuses.push(response.statusCode);
      }
      const accepted = await f.app.inject({
        method: 'POST',
        url: '/api/concierge/home/clients',
        headers: owner,
        payload: { clientId: randomUUID() },
      });
      assert.equal(accepted.statusCode, 200, 'the original owner still has capacity after 32 rejected registrations');
      assert.deepEqual(statuses, Array(32).fill(403));
      assert.equal(typeof accepted.json().clientToken, 'string');
    } finally {
      f.hub.close();
      await f.app.close();
    }
  });
}

for (const headerUser of ['default-user', 'another-user']) {
  test(`a non-browser ${headerUser} identity header cannot allocate owner window capabilities`, async () => {
    const f = await fixture('default-user');
    try {
      for (let i = 0; i < 32; i++) {
        const response = await f.app.inject({
          method: 'POST',
          url: '/api/concierge/home/clients',
          headers: { 'x-cat-cafe-user': headerUser },
          payload: { clientId: randomUUID() },
        });
        assert.equal(response.statusCode, 401);
      }
      const owner = await f.session();
      const clientId = randomUUID();
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/concierge/home/clients',
        headers: owner,
        payload: { clientId },
      });
      assert.equal(response.statusCode, 200);
      const removed = await f.app.inject({
        method: 'DELETE',
        url: `/api/concierge/home/clients/${clientId}`,
        headers: owner,
        payload: { clientToken: response.json().clientToken },
      });
      assert.deepEqual(removed.json(), { released: true });
    } finally {
      f.hub.close();
      await f.app.close();
    }
  });
}

test('release and consume use the same configured owner session boundary as registration', async () => {
  const f = await fixture('custom-owner');
  try {
    const owner = await f.session();
    const stranger = await f.session('192.0.2.12');
    const clientId = randomUUID();
    const registered = await f.app.inject({
      method: 'POST',
      url: '/api/concierge/home/clients',
      headers: owner,
      payload: { clientId },
    });
    assert.equal(registered.statusCode, 200);
    const clientToken = registered.json().clientToken;
    for (const [headers, status] of [
      [stranger, 403],
      [{ 'x-cat-cafe-user': 'custom-owner' }, 401],
    ] as const) {
      const released = await f.app.inject({
        method: 'DELETE',
        url: `/api/concierge/home/clients/${clientId}`,
        headers,
        payload: { clientToken },
      });
      assert.equal(released.statusCode, status);
      const consumed = await f.app.inject({
        method: 'POST',
        url: `/api/concierge/home/commands/${randomUUID()}`,
        headers,
        payload: { clientId, clientToken },
      });
      assert.equal(consumed.statusCode, status);
    }
    const released = await f.app.inject({
      method: 'DELETE',
      url: `/api/concierge/home/clients/${clientId}`,
      headers: owner,
      payload: { clientToken },
    });
    assert.deepEqual(released.json(), { released: true });
  } finally {
    f.hub.close();
    await f.app.close();
  }
});
