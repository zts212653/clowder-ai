import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { io } from 'socket.io-client';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { SocketManager } from '../src/infrastructure/websocket/SocketManager.js';

async function fixture(ownerUserId: string, authenticated: boolean) {
  const app = Fastify();
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId });
  const manager = new SocketManager(app.server);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const issued = await app.inject({ method: 'GET', url: '/api/session' });
  assert.equal(issued.json().userId, ownerUserId);
  const sessionCookie = String(issued.headers['set-cookie']).split(';')[0];
  const client = io(`http://127.0.0.1:${address.port}`, {
    transports: ['websocket'],
    forceNew: true,
    auth: { userId: ownerUserId },
    query: { userId: ownerUserId },
    extraHeaders: { Cookie: authenticated ? sessionCookie : 'cat_cafe_session=forged', 'x-cat-cafe-user': ownerUserId },
  });
  await once(client, 'connect');
  return {
    app,
    manager,
    client,
    close: async () => {
      client.disconnect();
      manager.close();
      await app.close();
    },
  };
}

test('the original HTTP custom-owner session receives home broadcasts through the actual SocketManager', async () => {
  const f = await fixture('custom-owner', true);
  try {
    f.client.on('home:inspect', (_data, acknowledge) => acknowledge({ receivedBy: 'custom-owner' }));
    assert.deepEqual(await f.manager.broadcastToRoomWithAck('user:custom-owner', 'home:inspect', {}, 1_000), [
      { receivedBy: 'custom-owner' },
    ]);
    const allowed = await new Promise((resolve) => f.client.emit('join_room', 'user:custom-owner', resolve));
    assert.deepEqual(allowed, { ok: true, room: 'user:custom-owner' });
    const denied = await new Promise((resolve) => f.client.emit('join_room', 'user:another-owner', resolve));
    assert.deepEqual(denied, { ok: false, room: 'user:another-owner', error: 'forbidden_room' });
  } finally {
    await f.close();
  }
});

test('query, auth and header claims or a forged cookie cannot join the configured owner room', async () => {
  const f = await fixture('custom-owner', false);
  try {
    f.client.on('home:inspect', (_data, acknowledge) => acknowledge({ forged: true }));
    assert.deepEqual(await f.manager.broadcastToRoomWithAck('user:custom-owner', 'home:inspect', {}, 1_000), []);
    const denied = await new Promise((resolve) => f.client.emit('join_room', 'user:custom-owner', resolve));
    assert.deepEqual(denied, { ok: false, room: 'user:custom-owner', error: 'forbidden_room' });
  } finally {
    await f.close();
  }
});

test('the existing default-owner browser session still receives its original room', async () => {
  const f = await fixture('default-user', true);
  try {
    f.client.on('home:inspect', (_data, acknowledge) => acknowledge({ receivedBy: 'default-user' }));
    assert.deepEqual(await f.manager.broadcastToRoomWithAck('user:default-user', 'home:inspect', {}, 1_000), [
      { receivedBy: 'default-user' },
    ]);
  } finally {
    await f.close();
  }
});
