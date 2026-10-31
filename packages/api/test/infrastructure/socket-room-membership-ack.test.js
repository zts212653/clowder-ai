import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import { io as ioClient } from 'socket.io-client';
import { SocketManager } from '../../dist/infrastructure/websocket/SocketManager.js';

describe('SocketManager room membership acknowledgement', () => {
  let httpServer;
  let socketManager;
  let client;

  afterEach(async () => {
    client?.disconnect();
    socketManager?.close();
    if (httpServer?.listening) {
      await new Promise((resolve) => httpServer.close(resolve));
    }
  });

  async function connectClient() {
    httpServer = createServer();
    socketManager = new SocketManager(httpServer);
    httpServer.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    client = ioClient(`http://127.0.0.1:${address.port}`, {
      transports: ['websocket'],
      forceNew: true,
    });
    await once(client, 'connect');
  }

  it('acknowledges only after the socket has joined the requested thread room', { timeout: 3_000 }, async () => {
    await connectClient();

    const ack = await new Promise((resolve) => {
      client.emit('join_room', 'thread:room-ack', resolve);
    });

    assert.deepEqual(ack, { ok: true, room: 'thread:room-ack' });
    assert.ok(socketManager.getIO().sockets.adapter.rooms.get('thread:room-ack')?.has(client.id));
  });

  it('returns a negative acknowledgement for an invalid room', { timeout: 3_000 }, async () => {
    await connectClient();

    const ack = await new Promise((resolve) => {
      client.emit('join_room', 'admin:secret', resolve);
    });

    assert.deepEqual(ack, { ok: false, room: 'admin:secret', error: 'invalid_room' });
  });

  it('rejects a non-string room without crashing the socket handler', { timeout: 3_000 }, async () => {
    await connectClient();

    const ack = await new Promise((resolve) => {
      client.emit('join_room', { unexpected: true }, resolve);
    });

    assert.deepEqual(ack, { ok: false, room: '', error: 'invalid_room' });
    assert.equal(client.connected, true);
  });
});
