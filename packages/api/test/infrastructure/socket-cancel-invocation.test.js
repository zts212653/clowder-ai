import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { io as ioClient } from 'socket.io-client';

const { SocketManager } = await import('../../dist/infrastructure/websocket/SocketManager.js');

function connectClient(port, auth = { userId: 'default-user' }) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      autoConnect: true,
      reconnection: false,
      timeout: 2000,
      extraHeaders: { origin: 'http://localhost:3003' },
      auth,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('SocketManager cancel_invocation', () => {
  let httpServer;
  let socketManager;
  let port;
  let invocationTracker;
  let queueProcessor;

  beforeEach(async () => {
    httpServer = createServer();
    invocationTracker = {
      cancel: mock.fn(() => ({ cancelled: true, catIds: ['opus'] })),
      cancelAll: mock.fn(() => ['opus', 'codex']),
      startAll: mock.fn(() => new AbortController()),
      completeAll: mock.fn(),
      has: mock.fn(() => false),
    };
    queueProcessor = {
      clearPause: mock.fn(),
      releaseSlot: mock.fn(),
      processNext: mock.fn(async () => ({ started: false })),
    };
    socketManager = new SocketManager(httpServer, invocationTracker);
    socketManager.setQueueProcessor(queueProcessor);

    await new Promise((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        port = httpServer.address().port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    socketManager?.close();
    await new Promise((resolve) => httpServer?.close(resolve));
  });

  it('cancel_all broadcasts cancel messages and clears queue processor slots for each cancelled cat', async () => {
    const socket = await connectClient(port);
    const received = [];
    socket.on('agent_message', (msg) => received.push(msg));
    socket.emit('join_room', 'thread:thread-1');
    await new Promise((resolve) => setTimeout(resolve, 30));

    socket.emit('cancel_invocation', { threadId: 'thread-1' });
    await waitFor(
      () =>
        received.filter((msg) => msg.type === 'system_info').length === 1 &&
        received.filter((msg) => msg.type === 'done').length === 2,
    );

    assert.equal(invocationTracker.cancelAll.mock.calls.length, 1);
    assert.deepEqual(
      queueProcessor.clearPause.mock.calls.map((call) => call.arguments),
      [
        ['thread-1', 'opus'],
        ['thread-1', 'codex'],
      ],
    );
    assert.deepEqual(
      queueProcessor.releaseSlot.mock.calls.map((call) => call.arguments),
      [
        ['thread-1', 'opus'],
        ['thread-1', 'codex'],
      ],
    );
    assert.deepEqual(
      invocationTracker.cancelAll.mock.calls.map((call) => call.arguments),
      [['thread-1', 'default-user', 'user_cancel']],
    );
    assert.equal(received.filter((msg) => msg.type === 'system_info').length, 1);
    assert.deepEqual(
      received
        .filter((msg) => msg.type === 'done')
        .map((msg) => msg.catId)
        .sort(),
      ['codex', 'opus'],
    );

    socket.disconnect();
  });

  it('slot-specific cancel clears queue processor state for the cancelled cat', async () => {
    const socket = await connectClient(port);
    const received = [];
    socket.on('agent_message', (msg) => received.push(msg));
    socket.emit('join_room', 'thread:thread-1');
    await new Promise((resolve) => setTimeout(resolve, 30));

    socket.emit('cancel_invocation', { threadId: 'thread-1', catId: 'opus' });
    await waitFor(
      () =>
        received.filter((msg) => msg.type === 'system_info').length === 1 &&
        received.filter((msg) => msg.type === 'done').length === 1,
    );

    assert.equal(invocationTracker.cancel.mock.calls.length, 1);
    assert.deepEqual(
      queueProcessor.clearPause.mock.calls.map((call) => call.arguments),
      [['thread-1', 'opus']],
    );
    assert.deepEqual(
      queueProcessor.releaseSlot.mock.calls.map((call) => call.arguments),
      [['thread-1', 'opus']],
    );
    assert.deepEqual(
      invocationTracker.cancel.mock.calls.map((call) => call.arguments),
      [['thread-1', 'opus', 'default-user', 'user_cancel']],
    );
    assert.equal(received.filter((msg) => msg.type === 'system_info').length, 1);
    assert.deepEqual(
      received.filter((msg) => msg.type === 'done').map((msg) => msg.catId),
      ['opus'],
    );

    socket.disconnect();
  });
});
