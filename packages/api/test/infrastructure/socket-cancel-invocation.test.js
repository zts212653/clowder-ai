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
  throw new Error(`Timed out after ${timeoutMs}ms waiting for SocketManager test condition`);
}

function explicitCancel(overrides = {}) {
  return {
    threadId: 'thread-1',
    origin: 'explicit_stop',
    actionId: `action-${Date.now()}-${Math.random()}`,
    clientInstanceId: 'client-test-1',
    sourceControl: 'chat_input_action',
    gesture: 'pointer',
    trustedGesture: true,
    ...overrides,
  };
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
      cancel: mock.fn(() => ({ cancelled: true, catIds: ['opus'], executionIds: ['inv-opus'] })),
      cancelAll: mock.fn(() => ({
        catIds: ['opus', 'codex'],
        executionIds: ['inv-opus', 'inv-codex'],
        executionIdByCatId: {
          opus: 'inv-opus',
          codex: 'inv-codex',
        },
      })),
      startAll: mock.fn(() => new AbortController()),
      completeAll: mock.fn(),
      has: mock.fn(() => false),
      getUserId: mock.fn(() => null),
    };
    queueProcessor = {
      canReleaseSlotForUser: mock.fn(() => true),
      clearPause: mock.fn(),
      releaseSlot: mock.fn(),
      suppressAutoResume: mock.fn(),
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

    socket.emit('cancel_invocation', explicitCancel());
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
    // cancelAll must suppress auto-resume for each cancelled cat (covers direct invocations)
    assert.deepEqual(
      queueProcessor.suppressAutoResume.mock.calls.map((call) => call.arguments),
      [
        ['thread-1', 'opus', ['inv-opus']],
        ['thread-1', 'codex', ['inv-codex']],
      ],
    );
    assert.deepEqual(
      invocationTracker.cancelAll.mock.calls.map((call) => call.arguments),
      [['thread-1', 'default-user', 'cancel_all']],
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

    socket.emit('cancel_invocation', explicitCancel({ catId: 'opus' }));
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

  it('releases agent session locks after abort for slot and cancel-all scopes', async () => {
    const lifecycle = [];
    invocationTracker.cancel = mock.fn(() => {
      lifecycle.push('abort-slot');
      return { cancelled: true, catIds: ['opus'], executionIds: ['inv-opus'] };
    });
    invocationTracker.cancelAll = mock.fn(() => {
      lifecycle.push('abort-all');
      return {
        catIds: ['opus', 'codex'],
        executionIds: ['inv-opus', 'inv-codex'],
      };
    });
    const lockRecoveries = [];
    socketManager.setAgentSessionMutex({
      forceReleaseByScope(scope, options) {
        lifecycle.push('release-lock');
        lockRecoveries.push({ scope, options });
        return { releasedHolders: 1, rejectedWaiters: 0 };
      },
    });
    const socket = await connectClient(port);
    socket.emit('join_room', 'thread:thread-1');
    await new Promise((resolve) => setTimeout(resolve, 30));

    socket.emit('cancel_invocation', explicitCancel({ catId: 'opus' }));
    await waitFor(() => lockRecoveries.length === 1);
    socket.emit('cancel_invocation', explicitCancel());
    await waitFor(() => lockRecoveries.length === 2);

    assert.deepEqual(lifecycle.slice(0, 2), ['abort-slot', 'release-lock']);
    assert.deepEqual(lifecycle.slice(2, 4), ['abort-all', 'release-lock']);
    assert.deepEqual(lockRecoveries, [
      {
        scope: { threadId: 'thread-1', userId: 'default-user', catId: 'opus' },
        options: { preserveHolderExecutionIds: ['inv-opus'] },
      },
      {
        scope: { threadId: 'thread-1', userId: 'default-user' },
        options: { preserveHolderExecutionIds: ['inv-opus', 'inv-codex'] },
      },
    ]);
    socket.disconnect();
  });

  it('recovers a tracker-missing slot when an owner-scoped session lock is force-released', async () => {
    invocationTracker.cancel = mock.fn(() => ({ cancelled: false, catIds: [] }));
    socketManager.setAgentSessionMutex({
      forceReleaseByScope() {
        return { releasedHolders: 1, rejectedWaiters: 0, catIds: ['opus'] };
      },
    });
    const socket = await connectClient(port);
    const received = [];
    socket.on('agent_message', (msg) => received.push(msg));
    socket.emit('join_room', 'thread:thread-1');
    await new Promise((resolve) => setTimeout(resolve, 30));

    socket.emit('cancel_invocation', explicitCancel({ catId: 'opus' }));
    await waitFor(() => received.some((msg) => msg.type === 'done' && msg.catId === 'opus'));

    assert.deepEqual(
      queueProcessor.clearPause.mock.calls.map((call) => call.arguments),
      [['thread-1', 'opus']],
    );
    assert.deepEqual(
      queueProcessor.releaseSlot.mock.calls.map((call) => call.arguments),
      [['thread-1', 'opus']],
    );
    socket.disconnect();
  });

  it('does not let a stale user lock cancel a foreign active slot', async () => {
    invocationTracker.cancel = mock.fn(() => ({ cancelled: false, catIds: [] }));
    invocationTracker.has = mock.fn(() => true);
    invocationTracker.getUserId = mock.fn(() => 'user-2');
    queueProcessor.canReleaseSlotForUser = mock.fn(() => false);
    let lockReleased = false;
    socketManager.setAgentSessionMutex({
      forceReleaseByScope() {
        lockReleased = true;
        return { releasedHolders: 1, rejectedWaiters: 0, catIds: ['opus'] };
      },
    });
    const socket = await connectClient(port);
    const received = [];
    socket.on('agent_message', (msg) => received.push(msg));
    socket.emit('join_room', 'thread:thread-1');
    await new Promise((resolve) => setTimeout(resolve, 30));

    socket.emit('cancel_invocation', explicitCancel({ catId: 'opus' }));
    await waitFor(() => lockReleased);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(received.length, 0);
    assert.equal(queueProcessor.clearPause.mock.calls.length, 0);
    assert.equal(queueProcessor.releaseSlot.mock.calls.length, 0);
    socket.disconnect();
  });

  it('does not let cancel-all lock recovery release a foreign active slot', async () => {
    invocationTracker.cancelAll = mock.fn(() => ({ catIds: [], executionIds: [] }));
    invocationTracker.has = mock.fn(() => true);
    invocationTracker.getUserId = mock.fn(() => 'user-2');
    queueProcessor.canReleaseSlotForUser = mock.fn(() => false);
    let lockReleased = false;
    socketManager.setAgentSessionMutex({
      forceReleaseByScope() {
        lockReleased = true;
        return { releasedHolders: 1, rejectedWaiters: 0, catIds: ['opus'] };
      },
    });
    const socket = await connectClient(port);
    const received = [];
    socket.on('agent_message', (msg) => received.push(msg));
    socket.emit('join_room', 'thread:thread-1');
    await new Promise((resolve) => setTimeout(resolve, 30));

    socket.emit('cancel_invocation', explicitCancel());
    await waitFor(() => lockReleased);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(received.length, 0);
    assert.equal(queueProcessor.clearPause.mock.calls.length, 0);
    assert.equal(queueProcessor.releaseSlot.mock.calls.length, 0);
    assert.equal(queueProcessor.suppressAutoResume.mock.calls.length, 0);
    socket.disconnect();
  });

  it('IR-9: rejects an unattributed legacy cancel packet instead of fabricating user intent', async () => {
    const socket = await connectClient(port);
    socket.emit('join_room', 'thread:thread-1');
    await new Promise((resolve) => setTimeout(resolve, 30));

    socket.emit('cancel_invocation', { threadId: 'thread-1', catId: 'opus' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(invocationTracker.cancel.mock.calls.length, 0);
    assert.equal(invocationTracker.cancelAll.mock.calls.length, 0);
    socket.disconnect();
  });

  it('rejects a self-attributed cancel without a trusted UI control gesture', async () => {
    const socket = await connectClient(port);
    socket.emit('join_room', 'thread:thread-1');
    await new Promise((resolve) => setTimeout(resolve, 30));

    socket.emit('cancel_invocation', {
      threadId: 'thread-1',
      catId: 'opus',
      origin: 'explicit_stop',
      actionId: 'action-self-attributed',
      clientInstanceId: 'client-test-1',
      sourceControl: 'chat_input_action',
      gesture: 'pointer',
      trustedGesture: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(invocationTracker.cancel.mock.calls.length, 0);
    assert.equal(invocationTracker.cancelAll.mock.calls.length, 0);
    socket.disconnect();
  });
});
