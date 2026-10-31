/** K-1 / F288 — deleted current state must not poison snapshot output fences. */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

let memory;
let handlesMod;
let ledgerMod;
let sendMod;
let appendMod;
let streamMod;
let MessageStore;

let messageStore;
let handles;
let cursors;
let events;
let sendService;
let stream;

const CTX = { pluginInstanceId: 'inst-a' };

beforeEach(async () => {
  memory = await import('../dist/domains/messaging/stores/memory.js');
  handlesMod = await import('../dist/domains/messaging/handles.js');
  ledgerMod = await import('../dist/domains/messaging/ledger.js');
  sendMod = await import('../dist/domains/messaging/send-service.js');
  appendMod = await import('../dist/domains/messaging/append-service.js');
  streamMod = await import('../dist/domains/messaging/event-stream.js');
  ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));

  messageStore = new MessageStore();
  cursors = new memory.MemoryCursorStore();
  const handleStore = new memory.MemoryHandleStore();
  handles = new handlesMod.HandleService(handleStore, cursors);
  events = new memory.MemoryEventLogStore();
  sendService = new sendMod.SendService({
    messageStore,
    handles,
    ledger: new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore()),
    events,
    isKnownCatId: () => true,
  });
  stream = new streamMod.EventStreamService({ events, cursors, handles, messageStore });
});

async function issueHandle() {
  const { handleId } = await handles.issueThreadHandle({
    pluginInstanceId: CTX.pluginInstanceId,
    threadId: 'thread-1',
    userId: 'user-1',
    scope: { canSend: true, canSubscribe: true },
  });
  return handleId;
}

function draft(handleId, idempotencyKey) {
  return {
    address: { kind: 'thread_handle', handle: handleId },
    idempotencyKey,
    payload: {
      provenance: { epistemicStatus: 'inference' },
      elements: [{ elementId: 'el-1', kind: 'text', payload: { text: idempotencyKey } }],
    },
  };
}

function gateEvent(targetType) {
  let release;
  let markBlocked;
  const blocked = new Promise((resolve) => {
    markBlocked = resolve;
  });
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const gatedEvents = new Proxy(events, {
    get(target, prop, receiver) {
      if (prop === 'append') {
        return async (...args) => {
          if (args[2].type === targetType) {
            markBlocked();
            await wait;
          }
          return target.append(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { blocked, gatedEvents, release };
}

async function captureSnapshotBeforeRelease(subscriptionId, release, pendingOperation) {
  let result;
  let snapshotError;
  try {
    result = await stream.snapshot(CTX, subscriptionId);
  } catch (err) {
    snapshotError = err;
  } finally {
    release();
    await pendingOperation;
  }
  if (snapshotError) throw snapshotError;
  return result;
}

describe('EventStreamService — snapshot deletion races', () => {
  test('soft delete while publish is pending does not permanently block snapshot', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    const gate = gateEvent('message.publish');
    const gatedSend = new sendMod.SendService({
      messageStore,
      handles,
      ledger: new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore()),
      events: gate.gatedEvents,
      isKnownCatId: () => true,
    });

    const pendingSend = gatedSend.send(CTX, draft(handleId, 'delete-before-publish'));
    await gate.blocked;
    const [persisted] = await messageStore.getByThreadAfter('thread-1');
    assert.ok(persisted);
    messageStore.softDelete(persisted.id, 'user-1');

    const beforePublish = await captureSnapshotBeforeRelease(subscriptionId, gate.release, pendingSend);
    assert.deepEqual(beforePublish.envelopes, []);
    assert.equal(beforePublish.resumeSequence, 0);
    const afterPublish = await stream.snapshot(CTX, subscriptionId);
    assert.deepEqual(afterPublish.envelopes, []);
    assert.equal(afterPublish.resumeSequence, 1);
  });

  test('soft delete while append output is pending does not permanently block snapshot', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    const sent = await sendService.send(CTX, draft(handleId, 'delete-before-append'));
    const gate = gateEvent('message.elements.append');
    const append = new appendMod.AppendService({
      messageStore,
      handles,
      ledger: new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore()),
      events: gate.gatedEvents,
      appendLock: new memory.MemoryAppendLock(),
    });

    const pendingAppend = append.appendElements(CTX, {
      handle: sent.messageHandle,
      operationId: 'delete-before-append-output',
      elements: [{ elementId: 'el-2', kind: 'text', payload: { text: 'pending append' } }],
    });
    await gate.blocked;
    messageStore.softDelete(sent.messageId, 'user-1');

    const beforeAppend = await captureSnapshotBeforeRelease(subscriptionId, gate.release, pendingAppend);
    assert.deepEqual(beforeAppend.envelopes, []);
    assert.equal(beforeAppend.resumeSequence, 1);
    const afterAppend = await stream.snapshot(CTX, subscriptionId);
    assert.deepEqual(afterAppend.envelopes, []);
    assert.equal(afterAppend.resumeSequence, 2);
  });
});
