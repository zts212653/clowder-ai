/**
 * K-1 / F288 — adversarial append emitter fencing.
 * A stale lease holder must never add revision N after a successor exposed N+1.
 */
import assert from 'node:assert/strict';
import { before, beforeEach, describe, test } from 'node:test';

let memory;
let handlesMod;
let ledgerMod;
let sendMod;
let appendMod;
let streamMod;
let MessageStore;

const CTX = { pluginInstanceId: 'inst-a' };

before(async () => {
  memory = await import('../dist/domains/messaging/stores/memory.js');
  handlesMod = await import('../dist/domains/messaging/handles.js');
  ledgerMod = await import('../dist/domains/messaging/ledger.js');
  sendMod = await import('../dist/domains/messaging/send-service.js');
  appendMod = await import('../dist/domains/messaging/append-service.js');
  streamMod = await import('../dist/domains/messaging/event-stream.js');
  ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));
});

let messageStore;
let handles;
let events;
let stream;
let handleId;
let sent;

function createTakeoverLock() {
  let current = null;
  let generation = 0;
  return {
    async acquire(messageId) {
      generation += 1;
      const lease = {
        messageId,
        token: `lease-${generation}`,
        isCurrent: () => current === lease,
      };
      current = lease;
      return lease;
    },
    async release(_messageId, lease) {
      if (current === lease) current = null;
    },
    expire() {
      current = null;
    },
  };
}

function appendInput(operationId, elementId) {
  return {
    handle: sent.handle,
    operationId,
    elements: [{ elementId, kind: 'text', payload: { text: operationId } }],
  };
}

async function expectCode(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert.equal(err.name, 'MessagingError', `expected MessagingError, got ${err.name}: ${err.message}`);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected MessagingError(${code}), but call succeeded`);
}

beforeEach(async () => {
  messageStore = new MessageStore();
  const cursors = new memory.MemoryCursorStore();
  handles = new handlesMod.HandleService(new memory.MemoryHandleStore(), cursors);
  events = new memory.MemoryEventLogStore();
  const ledger = new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore());
  const send = new sendMod.SendService({ messageStore, handles, ledger, events, retentionCount: 1 });
  stream = new streamMod.EventStreamService({ events, cursors, handles, messageStore });
  ({ handleId } = await handles.issueThreadHandle({
    pluginInstanceId: 'inst-a',
    threadId: 'thread-1',
    userId: 'user-1',
    scope: { canSend: true, canSubscribe: true },
  }));
  sent = await send.send(CTX, {
    address: { kind: 'thread_handle', handle: handleId },
    idempotencyKey: 'base-message',
    payload: {
      provenance: { epistemicStatus: 'inference' },
      elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'base' } }],
    },
  });
});

function gatedAppendService(lock) {
  let releaseFirst;
  let markFirstBlocked;
  const firstBlocked = new Promise((resolve) => {
    markFirstBlocked = resolve;
  });
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let blockFirst = true;
  const gatedEvents = new Proxy(events, {
    get(target, prop, receiver) {
      if (prop === 'append') {
        return async (...args) => {
          const event = args[2];
          if (blockFirst && event.type === 'message.elements.append' && event.operationId === 'op-1') {
            blockFirst = false;
            markFirstBlocked();
            await firstGate;
          }
          return target.append(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const service = new appendMod.AppendService({
    messageStore,
    handles,
    ledger: new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore()),
    events: gatedEvents,
    appendLock: lock,
    retentionCount: 1,
  });
  return { service, firstBlocked, releaseFirst };
}

describe('AppendService — stale emitter fencing', () => {
  test('INV-17: snapshot revision 3 is never followed by a newly inserted revision 2 event', async () => {
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    const lock = createTakeoverLock();
    const { service, firstBlocked, releaseFirst } = gatedAppendService(lock);

    const first = service.appendElements(CTX, appendInput('op-1', 'el-2'));
    await firstBlocked;
    const second = await service.appendElements(CTX, appendInput('op-2', 'el-3'));
    const snapshot = await stream.snapshot(CTX, subscriptionId);
    assert.equal(snapshot.envelopes[0].revision, 3);
    assert.equal(snapshot.resumeSequence, second.appendSequence);

    releaseFirst();
    assert.equal((await first).revision, 2);

    const afterSnapshot = await stream.read(CTX, subscriptionId, { limit: 32 });
    assert.deepEqual(afterSnapshot.events, []);
    const retained = await events.readAfter('thread-1', 0, 32);
    assert.deepEqual(
      retained.map((event) => [event.operationId, event.revision]),
      [['op-2', 3]],
    );
  });

  test('INV-18: expiry without successor output is retryable and a later lease repairs it', async () => {
    const lock = createTakeoverLock();
    const { service, firstBlocked, releaseFirst } = gatedAppendService(lock);

    const first = service.appendElements(CTX, appendInput('op-1', 'el-2'));
    await firstBlocked;
    lock.expire();
    releaseFirst();
    await expectCode(first, 'RETRYABLE_INFLIGHT');

    const retry = await service.appendElements(CTX, appendInput('op-1', 'el-2'));
    assert.equal(retry.revision, 2);
    assert.equal(typeof retry.appendSequence, 'number');
  });
});
