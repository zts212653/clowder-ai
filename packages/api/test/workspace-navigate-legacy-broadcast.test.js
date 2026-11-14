// A page whose one connection is in both workspace:global (for teleports) and the
// navigation ack room must get the acknowledged copy only; an old page that is only in the
// legacy room still gets the fire-and-forget copy (F223 keeps it for migrating Hubs).
import assert from 'node:assert/strict';
import { Server as HttpServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import {
  emitWorkspaceNavigate,
  WORKSPACE_NAVIGATION_ACK_ROOM,
} from '../dist/domains/workspace/workspace-navigation-delivery.js';
import { SocketManager } from '../dist/infrastructure/websocket/SocketManager.js';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connect(port, rooms) {
  const client = ioClient(`http://localhost:${port}`, { transports: ['websocket'] });
  await new Promise((resolve) => client.on('connect', resolve));
  for (const room of rooms) {
    await new Promise((resolve) => client.emit('join_room', room, resolve));
  }
  return client;
}

describe('workspace navigation legacy broadcast', () => {
  let httpServer;
  let io;
  let port;
  let emitter;

  before(async () => {
    httpServer = new HttpServer();
    io = new Server(httpServer, { cors: { origin: '*' } });
    io.on('connection', (socket) => {
      socket.on('join_room', (room, ack) => {
        socket.join(room);
        ack?.({ ok: true, room });
      });
    });
    await new Promise((resolve) => httpServer.listen(0, resolve));
    port = httpServer.address().port;
    // The same wiring as the workspace routes in index.ts.
    const manager = { io };
    emitter = {
      socketEmit: (event, data, room, options) =>
        SocketManager.prototype.broadcastToRoom.call(manager, room, event, data, options),
      socketEmitWithAck: (event, data, room) =>
        SocketManager.prototype.broadcastToRoomWithAck.call(manager, room, event, data, 1000),
    };
  });

  after(async () => {
    await new Promise((resolve) => io.close(resolve));
    if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
  });

  it('sends a dual-room page only the acknowledged copy and an old page the legacy copy', async () => {
    const modern = await connect(port, ['workspace:global', WORKSPACE_NAVIGATION_ACK_ROOM]);
    const legacy = await connect(port, ['workspace:global']);
    const modernDeliveries = [];
    const legacyDeliveries = [];
    const seen = new Set();
    // Mirrors the Hub: the first delivery of an event is processed, repeats are dropped.
    modern.on('workspace:navigate', (event, ack) => {
      modernDeliveries.push({ eventId: event.eventId, withAck: typeof ack === 'function' });
      if (seen.has(event.eventId)) return;
      seen.add(event.eventId);
      ack?.({ status: 'applied', eventId: event.eventId });
    });
    legacy.on('workspace:navigate', (event, ack) => {
      legacyDeliveries.push({ eventId: event.eventId, withAck: typeof ack === 'function' });
    });

    try {
      const delivery = await emitWorkspaceNavigate(emitter, { eventId: 'nav-1' }, ['workspace:global']);
      await wait(100);

      assert.equal(delivery.deliveryStatus, 'applied');
      assert.deepEqual(modernDeliveries, [{ eventId: 'nav-1', withAck: true }]);
      assert.deepEqual(legacyDeliveries, [{ eventId: 'nav-1', withAck: false }]);
    } finally {
      modern.close();
      legacy.close();
    }
  });
});
