import assert from 'node:assert/strict';
import { once } from 'node:events';
import { afterEach, describe, it } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { io as ioClient } from 'socket.io-client';
import { sessionAuthPlugin, sessionRoute } from '../../dist/infrastructure/session-auth.js';
import { SocketManager } from '../../dist/infrastructure/websocket/SocketManager.js';

describe('SocketManager shares the HTTP session principal', () => {
  let app;
  let manager;
  const clients = [];
  afterEach(async () => {
    for (const client of clients.splice(0)) client.disconnect();
    manager?.close();
    await app?.close();
  });

  async function start(ownerUserId = 'acceptance-owner') {
    app = Fastify();
    await app.register(cookie);
    await app.register(sessionAuthPlugin);
    await app.register(sessionRoute, { ownerUserId });
    manager = new SocketManager(app.server);
    await app.listen({ host: '127.0.0.1', port: 0 });
    return `http://127.0.0.1:${app.server.address().port}`;
  }

  async function connect(url, cookieHeader, auth = {}) {
    const client = ioClient(url, {
      transports: ['websocket'],
      forceNew: true,
      auth,
      ...(cookieHeader ? { extraHeaders: { Cookie: cookieHeader } } : {}),
    });
    clients.push(client);
    await once(client, 'connect');
    return client;
  }

  function join(client, room) {
    return new Promise((resolve) => client.emit('join_room', room, resolve));
  }

  it('delivers user Queue events to the same owner as real HTTP bootstrap', { timeout: 5_000 }, async () => {
    const url = await start();
    const response = await fetch(`${url}/api/session`);
    assert.deepEqual(await response.json(), { userId: 'acceptance-owner' });
    const client = await connect(url, response.headers.get('set-cookie').split(';')[0], { userId: 'forged-user' });
    assert.deepEqual(await join(client, 'user:acceptance-owner'), { ok: true, room: 'user:acceptance-owner' });
    assert.equal(manager.getIO().sockets.adapter.rooms.get('user:default-user')?.has(client.id) ?? false, false);
    const received = once(client, 'queue_updated');
    manager.emitToUser('acceptance-owner', 'queue_updated', {
      threadId: 'owned-thread',
      queue: [{ id: 'pending-entry' }],
    });
    assert.deepEqual((await received)[0], { threadId: 'owned-thread', queue: [{ id: 'pending-entry' }] });
    client.disconnect();
    const connected = once(client, 'connect');
    client.connect();
    await connected;
    assert.deepEqual(await join(client, 'user:acceptance-owner'), { ok: true, room: 'user:acceptance-owner' });
  });

  it('does not promote a remote bootstrap session to the instance owner', { timeout: 5_000 }, async () => {
    const url = await start();
    const response = await app.inject({ method: 'GET', url: '/api/session', remoteAddress: '203.0.113.10' });
    assert.deepEqual(response.json(), { userId: 'default-user' });
    const client = await connect(url, response.headers['set-cookie'].split(';')[0], { userId: 'acceptance-owner' });
    assert.deepEqual(await join(client, 'user:acceptance-owner'), {
      ok: false,
      room: 'user:acceptance-owner',
      error: 'forbidden_room',
    });
    assert.deepEqual(await join(client, 'user:default-user'), { ok: true, room: 'user:default-user' });
  });

  it('ignores forged auth metadata and an unrecognized session token', { timeout: 5_000 }, async () => {
    const url = await start();
    const client = await connect(url, 'cat_cafe_session=not-a-session', { userId: 'acceptance-owner' });
    assert.deepEqual(await join(client, 'user:acceptance-owner'), {
      ok: false,
      room: 'user:acceptance-owner',
      error: 'forbidden_room',
    });
    assert.deepEqual(await join(client, 'user:default-user'), { ok: true, room: 'user:default-user' });
  });

  it('keeps an unpaired remote session distinct from the default owner', { timeout: 5_000 }, async () => {
    const url = await start('default-user');
    const response = await app.inject({ method: 'GET', url: '/api/session', remoteAddress: '203.0.113.10' });
    assert.deepEqual(response.json(), { userId: 'unpaired-user' });
    const client = await connect(url, response.headers['set-cookie'].split(';')[0], { userId: 'default-user' });
    assert.deepEqual(await join(client, 'user:unpaired-user'), { ok: true, room: 'user:unpaired-user' });
    assert.deepEqual(await join(client, 'user:default-user'), {
      ok: false,
      room: 'user:default-user',
      error: 'forbidden_room',
    });
  });

  it('keeps the existing anonymous single-user client boundary', { timeout: 5_000 }, async () => {
    const url = await start();
    const client = await connect(url, undefined, { userId: 'acceptance-owner' });
    assert.deepEqual(await join(client, 'user:default-user'), { ok: true, room: 'user:default-user' });
    assert.deepEqual(await join(client, 'user:acceptance-owner'), {
      ok: false,
      room: 'user:acceptance-owner',
      error: 'forbidden_room',
    });
  });
});
