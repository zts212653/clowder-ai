import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { SocketManager } from '../dist/infrastructure/websocket/SocketManager.js';
import { stopFixture, waitFor } from './helpers/stop-private-fixture.js';

const { io } = createRequire(import.meta.url)('socket.io-client');

async function socketFixture(t, h) {
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
  return async (cat, owner) => {
    const controller = h.tracker.start('thread', cat, owner, [cat], 'new-stop');
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
        actionId: 'race-stop',
        clientInstanceId: 'race-client',
        sourceControl: 'chat_input_action',
        gesture: 'pointer',
        trustedGesture: true,
      });
    });
    return controller;
  };
}

function gateAttempt(h, source, stage, loseReceipt) {
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
  if (stage.startsWith('claim')) {
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

const cases = [
  ...['claim-before', 'claim-after', 'receiver', 'source', 'durable', 'record'].map((stage) => ({ stage })),
  { stage: 'claim-after', loseReceipt: true },
  { stage: 'claim-after', secondary: true },
  { stage: 'claim-after', unrelated: true },
  { stage: 'claim-after', foreignOwner: true },
  { stage: 'record', replaceClaim: true },
  { stage: 'record', restoreFailure: 'before-write' },
  { stage: 'record', restoreFailure: 'after-write' },
];
for (const scenario of cases) {
  test(`#2008 real Stop fences automatic admission ${JSON.stringify(scenario)}`, async (t) => {
    const h = await stopFixture(t, { idle: true });
    const cancel = await socketFixture(t, h);
    const startedTargets = [];
    const route = h.processor.deps.router.routeExecution;
    h.processor.deps.router.routeExecution = async function* (...args) {
      startedTargets.push([...args[4]]);
      yield* route(...args);
    };
    const userId = 'default-user';
    const from = { kind: 'user', userId };
    const targets = scenario.secondary ? ['sonnet', 'gemini'] : ['sonnet'];
    const source = await h.queue.send(
      h.messages,
      {
        from,
        userId,
        threadId: 'thread',
        content: 'pending source',
        mentions: targets,
        timestamp: Date.now(),
        deliveryStatus: 'queued',
      },
      {
        from,
        userId,
        threadId: 'thread',
        kind: 'conversation_input',
        ownerAuthProvenance: 'unknown',
        content: 'pending source',
        targetCats: targets,
        intent: 'execute',
        autoExecute: true,
      },
    );
    h.processor.suppressAutoResume('thread', 'sonnet', ['old-stop']);
    const gate = gateAttempt(h, source, scenario.stage, scenario.loseReceipt);
    t.after(() => gate.release());
    const completion = h.processor.onInvocationComplete('thread', 'sonnet', 'canceled_by_user', 'new-completion', []);
    const outcome = completion.then(
      () => undefined,
      (error) => error,
    );
    await gate.waiting;
    const stopCat = scenario.secondary || scenario.unrelated ? 'gemini' : 'sonnet';
    const owner = scenario.foreignOwner ? 'other-owner' : userId;
    const stopped = await cancel(stopCat, owner);
    assert.equal(stopped.signal.aborted, !scenario.foreignOwner);
    if (scenario.foreignOwner) h.tracker.complete('thread', stopCat, stopped);
    let replacementClaimId;
    if (scenario.replaceClaim) {
      const first = await h.queue.getDurableEntry('thread', source.entry.id);
      assert.equal(await h.queue.rollbackProcessingDurable('thread', source.entry.id, first.claimId), true);
      const replacement = await h.queue.markProcessingGroupAcrossUsersDurable(
        'thread',
        { entryId: source.entry.id, targetCats: targets },
        [source.entry.id],
      );
      replacementClaimId = replacement.entry.claimId;
      assert.notEqual(replacementClaimId, first.claimId);
    }
    if (scenario.restoreFailure) {
      const restore = h.ledger.restore.bind(h.ledger);
      h.ledger.restore = async (...args) => {
        if (scenario.restoreFailure === 'after-write') await restore(...args);
        throw new Error(`restore ${scenario.restoreFailure}`);
      };
    }
    gate.release();
    assert.equal(await outcome, scenario.loseReceipt ? gate.failure : undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const shouldStart = scenario.unrelated || scenario.foreignOwner;
    assert.deepEqual(h.starts, shouldStart ? ['pending source'] : []);
    if (!shouldStart) {
      await h.processor.requestDrain('thread');
      if (scenario.secondary) {
        await waitFor(() => h.starts.length === 1 && !h.processor.hasProcessingSlotReservation('thread', 'sonnet'));
        assert.deepEqual(startedTargets, [['sonnet']], 'fresh admission may continue the unaffected recipient only');
        const pending = await h.queue.getDurableEntry('thread', source.entry.id);
        assert.equal(pending.status, 'queued');
        assert.deepEqual(pending.targets, ['gemini']);
        return;
      }
      assert.deepEqual(h.starts, [], 'ordinary drain cannot renew the rejected pre-start grant');
      const entry = await h.queue.getDurableEntry('thread', source.entry.id);
      const remainsClaimed =
        scenario.loseReceipt || scenario.replaceClaim || scenario.restoreFailure === 'before-write';
      assert.equal(entry.status, remainsClaimed ? 'claimed' : 'queued');
      if (scenario.loseReceipt) assert.ok(entry.claimId, 'unknown committed claim is retained');
      if (replacementClaimId)
        assert.equal(entry.claimId, replacementClaimId, 'old admission cannot release a replacement claim');
    }
  });
}
