/**
 * K-1 / F288 — messaging.appendElements (plan Task 7, §4d)
 * AC-4: atomic append, no rewriting (INV-6), no provenance whitewashing
 * (INV-7), baseRevision conflicts (INV-10), idempotent replay (INV-12).
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

let memory;
let handlesMod;
let ledgerMod;
let sendMod;
let appendMod;
let MessageStore;

let messageStore;
let handles;
let events;
let appendLock;
let sendService;
let service;

const CTX = { pluginInstanceId: 'inst-a' };

beforeEach(async () => {
  memory = await import('../dist/domains/messaging/stores/memory.js');
  handlesMod = await import('../dist/domains/messaging/handles.js');
  ledgerMod = await import('../dist/domains/messaging/ledger.js');
  sendMod = await import('../dist/domains/messaging/send-service.js');
  appendMod = await import('../dist/domains/messaging/append-service.js');
  ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));

  messageStore = new MessageStore();
  handles = new handlesMod.HandleService(new memory.MemoryHandleStore(), new memory.MemoryCursorStore());
  events = new memory.MemoryEventLogStore();
  appendLock = new memory.MemoryAppendLock();
  const ledger = new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore());
  sendService = new sendMod.SendService({
    messageStore,
    handles,
    ledger,
    events,
    isKnownCatId: (catId) => catId === 'opus',
  });
  service = new appendMod.AppendService({ messageStore, handles, ledger, events, appendLock });
});

async function sendMessage(overrides = {}) {
  const { handleId } = await handles.issueThreadHandle({
    pluginInstanceId: 'inst-a',
    threadId: 'thread-1',
    userId: 'user-1',
    scope: { canSend: true, canSubscribe: true, allowedWhisperTargets: ['opus'] },
  });
  const receipt = await sendService.send(CTX, {
    address: { kind: 'thread_handle', handle: handleId },
    idempotencyKey: `send-${Math.random().toString(36).slice(2)}`,
    payload: {
      provenance: { epistemicStatus: 'user_intent' },
      elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'original' } }],
    },
    ...overrides,
  });
  return receipt;
}

function appendInput(handleOrToken, overrides = {}) {
  const handle = typeof handleOrToken === 'string' ? { kind: 'message', token: handleOrToken } : handleOrToken;
  return {
    handle,
    operationId: 'op-1',
    elements: [{ elementId: 'el-2', kind: 'text', payload: { text: 'appended' } }],
    ...overrides,
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

describe('AppendService — rejection paths (§4d)', () => {
  test('INV-10: baseRevision mismatch → CONFLICT with zero mutation', async () => {
    const sent = await sendMessage();
    await expectCode(service.appendElements(CTX, appendInput(sent.handle, { baseRevision: 99 })), 'CONFLICT');
    const stored = messageStore.getById(sent.messageId);
    assert.equal(stored.extra.pluginMessage.revision, 1);
    assert.equal(stored.extra.pluginMessage.elements.length, 1);
  });

  test('INV-6: colliding elementId → VALIDATION, original untouched', async () => {
    const sent = await sendMessage();
    await expectCode(
      service.appendElements(
        CTX,
        appendInput(sent.handle, {
          elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'overwrite attempt' } }],
        }),
      ),
      'VALIDATION',
    );
    const stored = messageStore.getById(sent.messageId);
    assert.equal(stored.extra.pluginMessage.elements[0].payload.text, 'original');
  });

  test('INV-12: crash replay rejects a reused operationId with a different element set', async () => {
    const sent = await sendMessage();
    let crashOnce = true;
    const baseLedger = new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore());
    const crashyLedger = new Proxy(baseLedger, {
      get(target, prop, receiver) {
        if (prop === 'settleAppend') {
          return async (...args) => {
            if (crashOnce) {
              crashOnce = false;
              throw new Error('crash after append write');
            }
            return target.settleAppend(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const crashy = new appendMod.AppendService({ messageStore, handles, ledger: crashyLedger, events, appendLock });
    await assert.rejects(crashy.appendElements(CTX, appendInput(sent.handle)), /crash after append write/);

    await expectCode(
      crashy.appendElements(
        CTX,
        appendInput(sent.handle, {
          elements: [{ elementId: 'el-DIFFERENT', kind: 'text', payload: { text: 'not the applied operation' } }],
        }),
      ),
      'VALIDATION',
    );
    const stored = messageStore.getById(sent.messageId).extra.pluginMessage;
    assert.deepEqual(
      stored.elements.map((element) => element.elementId),
      ['el-1', 'el-2'],
    );
  });

  test('crash replay re-emits the original immutable baseRevision after event retention trim', async () => {
    const sent = await sendMessage();
    let crashOnce = true;
    const baseLedger = new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore());
    const crashyLedger = new Proxy(baseLedger, {
      get(target, prop, receiver) {
        if (prop === 'settleAppend') {
          return async (...args) => {
            if (crashOnce) {
              crashOnce = false;
              throw new Error('crash after append event');
            }
            return target.settleAppend(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const crashy = new appendMod.AppendService({
      messageStore,
      handles,
      ledger: crashyLedger,
      events,
      appendLock,
      retentionCount: 1,
    });
    await assert.rejects(
      crashy.appendElements(CTX, appendInput(sent.handle, { baseRevision: 1 })),
      /crash after append event/,
    );
    await events.append(
      'thread-1',
      'trim-original-append',
      {
        eventId: 'ev-trim',
        type: 'message.publish',
        envelope: {
          messageId: 'trim',
          revision: 1,
          threadId: 'thread-1',
          actor: { kind: 'system', id: 'test' },
          audience: { kind: 'public' },
          occurredAt: new Date().toISOString(),
          payload: { provenance: { origin: { kind: 'host' }, epistemicStatus: 'inference' }, elements: [] },
        },
      },
      1,
    );

    await crashy.appendElements(CTX, appendInput(sent.handle));
    const [replayed] = await events.readAfter('thread-1', 0, 10);
    assert.equal(replayed.type, 'message.elements.append');
    assert.equal(replayed.baseRevision, 1);
  });

  test('revision CAS prevents a stale lock holder from overwriting a successor append', async () => {
    const sent = await sendMessage();
    let injectSuccessor = true;
    const racingStore = new Proxy(messageStore, {
      get(target, prop, receiver) {
        if (prop === 'updatePluginMessage') {
          return (id, pluginMessage, expectedRevision) => {
            if (injectSuccessor) {
              injectSuccessor = false;
              const current = target.getById(id).extra.pluginMessage;
              target.updatePluginMessage(
                id,
                {
                  ...current,
                  revision: 2,
                  elements: [
                    ...current.elements,
                    {
                      elementId: 'el-successor',
                      kind: 'text',
                      payload: { text: 'successor won' },
                      epistemicStatus: 'inference',
                    },
                  ],
                  appendOps: [...current.appendOps, { operationId: 'op-successor', elementIds: ['el-successor'] }],
                },
                1,
              );
            }
            return target.updatePluginMessage(id, pluginMessage, expectedRevision);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const racing = new appendMod.AppendService({
      messageStore: racingStore,
      handles,
      ledger: new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore()),
      events,
      appendLock,
    });

    await expectCode(racing.appendElements(CTX, appendInput(sent.handle)), 'CONFLICT');
    const stored = messageStore.getById(sent.messageId).extra.pluginMessage;
    assert.equal(stored.revision, 2);
    assert.ok(stored.elements.some((element) => element.elementId === 'el-successor'));
    assert.ok(!stored.elements.some((element) => element.elementId === 'el-2'));
  });

  test('lease takeover preserves append event order after the prior revision was persisted', async () => {
    const sent = await sendMessage();
    let unblockFirstEvent;
    let markFirstEventBlocked;
    const firstEventBlocked = new Promise((resolve) => {
      markFirstEventBlocked = resolve;
    });
    const firstEventGate = new Promise((resolve) => {
      unblockFirstEvent = resolve;
    });
    let shouldBlockFirstEvent = true;
    const gatedEvents = new Proxy(events, {
      get(target, prop, receiver) {
        if (prop === 'append') {
          return async (...args) => {
            const event = args[2];
            if (shouldBlockFirstEvent && event.type === 'message.elements.append' && event.operationId === 'op-1') {
              shouldBlockFirstEvent = false;
              markFirstEventBlocked();
              await firstEventGate;
            }
            return target.append(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    let lockGeneration = 0;
    let currentLease = null;
    const expiringLock = {
      async acquire(messageId) {
        lockGeneration += 1;
        const lease = {
          messageId,
          token: `expired-lease-${lockGeneration}`,
          isCurrent: () => currentLease === lease,
        };
        currentLease = lease;
        return lease;
      },
      async release(_messageId, lease) {
        if (currentLease === lease) currentLease = null;
      },
    };
    const racing = new appendMod.AppendService({
      messageStore,
      handles,
      ledger: new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore()),
      events: gatedEvents,
      appendLock: expiringLock,
    });

    const first = racing.appendElements(CTX, appendInput(sent.handle, { operationId: 'op-1' }));
    await firstEventBlocked;
    const second = await racing.appendElements(
      CTX,
      appendInput(sent.handle, {
        operationId: 'op-2',
        elements: [{ elementId: 'el-3', kind: 'text', payload: { text: 'successor' } }],
      }),
    );
    unblockFirstEvent();
    const firstReceipt = await first;

    assert.equal(firstReceipt.revision, 2);
    assert.equal(second.revision, 3);
    const appendEvents = (await events.readAfter('thread-1', 0, 10)).filter(
      (event) => event.type === 'message.elements.append',
    );
    assert.deepEqual(
      appendEvents.map((event) => [event.operationId, event.revision]),
      [
        ['op-1', 2],
        ['op-2', 3],
      ],
      'a successor must repair the persisted predecessor event before publishing its own revision',
    );
    const finalPlugin = messageStore.getById(sent.messageId).extra.pluginMessage;
    assert.equal(finalPlugin.outputRevision, 3);
    assert.equal(
      finalPlugin.outputSequence,
      appendEvents[1].sequence,
      'a stale holder cannot regress the successor revision watermark',
    );
  });
});
