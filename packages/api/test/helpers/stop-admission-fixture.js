import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { SocketManager } from '../../dist/infrastructure/websocket/SocketManager.js';
import { stopFixture } from './stop-private-fixture.js';

const { io } = createRequire(import.meta.url)('socket.io-client');

export async function admissionFixture(t) {
  const h = await stopFixture(t, { idle: true });
  t.after(() => h.tracker.cancelAll('thread', 'default-user', 'test_cleanup'));
  return h;
}

export async function enqueueUser(h, content = 'pending source', targets = ['sonnet']) {
  const from = { kind: 'user', userId: 'default-user' };
  return h.queue.send(
    h.messages,
    {
      from,
      userId: 'default-user',
      threadId: 'thread',
      content,
      mentions: targets,
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    },
    {
      from,
      userId: 'default-user',
      threadId: 'thread',
      kind: 'conversation_input',
      ownerAuthProvenance: 'unknown',
      content,
      targetCats: targets,
      intent: 'execute',
      autoExecute: true,
    },
  );
}

export async function socketFixture(t, h) {
  const server = createServer();
  const sockets = new SocketManager(server, h.tracker);
  sockets.setQueueProcessor(h.processor);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socket = io(`http://127.0.0.1:${server.address().port}`, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { origin: 'http://127.0.0.1' },
  });
  t.after(async () => {
    socket.disconnect();
    sockets.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  await new Promise((resolve, reject) =>
    socket.emit('join_room', 'thread:thread', (reply) => (reply.ok ? resolve() : reject(new Error('join failed')))),
  );
  let stopSequence = 0;
  return async (cat, owner) => {
    const sequence = ++stopSequence;
    const executionId = sequence === 1 ? 'new-stop' : `new-stop-${sequence}`;
    const controller = h.tracker.start('thread', cat, owner, [cat], executionId);
    await new Promise((resolve) => {
      const cancelAll = h.tracker.cancelAll.bind(h.tracker);
      h.tracker.cancelAll = (...args) => {
        const result = cancelAll(...args);
        h.tracker.cancelAll = cancelAll;
        queueMicrotask(resolve);
        return result;
      };
      socket.emit('cancel_invocation', {
        threadId: 'thread',
        origin: 'explicit_stop',
        actionId: `race-stop-${sequence}`,
        clientInstanceId: 'race-client',
        sourceControl: 'chat_input_action',
        gesture: 'pointer',
        trustedGesture: true,
      });
    });
    return controller;
  };
}

export function gateAttempt(h, source, stage, loseReceipt) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  let blocked = false;
  const pause = async () => {
    if (blocked) return;
    blocked = true;
    entered();
    await gate;
  };
  const failure = new Error('exact claim committed but acknowledgement lost');
  if (stage === 'resolution') {
    const resolve = h.processor.deps.router.resolveExplicitTargets;
    h.processor.deps.router.resolveExplicitTargets = async (ids, ...args) => {
      if (ids.length > 1) await pause();
      return resolve(ids, ...args);
    };
  } else if (stage.startsWith('claim')) {
    const claim = h.ledger.claimPrefix.bind(h.ledger);
    h.ledger.claimPrefix = async (...args) => {
      if (!args[1].includes(source.entry.id)) return claim(...args);
      if (stage === 'claim-before') await pause();
      const result = await claim(...args);
      assert.equal(result.outcome, 'claimed');
      if (stage === 'claim-after') await pause();
      if (loseReceipt) throw failure;
      return result;
    };
  } else if (stage === 'receiver') {
    const reconcile = h.processor.reconcileClaimedGroupWithExistingReceiver.bind(h.processor);
    h.processor.reconcileClaimedGroupWithExistingReceiver = async (...args) => {
      const result = await reconcile(...args);
      if (args[0].some((entry) => entry.id === source.entry.id)) await pause();
      return result;
    };
  } else if (stage === 'record') {
    const create = h.records.create.bind(h.records);
    h.records.create = async (...args) => {
      const result = await create(...args);
      await pause();
      return result;
    };
  } else {
    let reserving = false;
    const reserve = h.processor.startReservedEntry.bind(h.processor);
    h.processor.startReservedEntry = async (...args) => {
      reserving = true;
      try {
        return await reserve(...args);
      } finally {
        reserving = false;
      }
    };
    const port = stage === 'source' ? h.messages : h.queue;
    const method = stage === 'source' ? 'getById' : 'getDurableEntry';
    const read = port[method].bind(port);
    port[method] = async (...args) => {
      const result = await read(...args);
      if (reserving) await pause();
      return result;
    };
  }
  return { waiting, release, failure };
}
