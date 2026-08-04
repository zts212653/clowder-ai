/**
 * K-1 / F288 — messaging.send (plan Task 5)
 * AC-1 single send entry + idempotent receipt (INV-1); AC-2 host-bound
 * envelope; D-4 origin stamping; whisper grant enforcement; §4a error paths.
 * Real stack: MessageStore (memory) + HandleService + MessagingLedger + event log. No mocks.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

let memory;
let handlesMod;
let ledgerMod;
let sendMod;
let MessageStore;

let messageStore;
let handles;
let ledger;
let events;
let service;

beforeEach(async () => {
  memory = await import('../dist/domains/messaging/stores/memory.js');
  handlesMod = await import('../dist/domains/messaging/handles.js');
  ledgerMod = await import('../dist/domains/messaging/ledger.js');
  sendMod = await import('../dist/domains/messaging/send-service.js');
  ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));

  messageStore = new MessageStore();
  handles = new handlesMod.HandleService(new memory.MemoryHandleStore(), new memory.MemoryCursorStore());
  ledger = new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore());
  events = new memory.MemoryEventLogStore();
  service = new sendMod.SendService({
    messageStore,
    handles,
    ledger,
    events,
    isKnownCatId: (catId) => ['opus', 'codex'].includes(catId),
  });
});

const CTX = { pluginInstanceId: 'inst-a' };

async function issueHandle(scope = { canSend: true, canSubscribe: true }) {
  const { handleId } = await handles.issueThreadHandle({
    pluginInstanceId: 'inst-a',
    threadId: 'thread-1',
    userId: 'user-1',
    scope,
  });
  return handleId;
}

function draftFor(handleId, overrides = {}) {
  return {
    address: { kind: 'thread_handle', handle: handleId },
    idempotencyKey: 'idem-1',
    payload: {
      provenance: { epistemicStatus: 'inference' },
      elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'hello from plugin' } }],
    },
    ...overrides,
  };
}

async function expectCode(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert.equal(err.name, 'MessagingError', `expected MessagingError, got ${err.name}: ${err.message}`);
    assert.equal(err.code, code);
    return err;
  }
  return assert.fail(`expected MessagingError(${code}), but call succeeded`);
}

describe('SendService — §4a adversarial paths', () => {
  test('claim stuck inflight → RETRYABLE_INFLIGHT (no message persisted)', async () => {
    const handleId = await issueHandle();
    await ledger.claimSend('inst-a', 'idem-1'); // simulate a concurrent in-flight send
    await expectCode(service.send(CTX, draftFor(handleId)), 'RETRYABLE_INFLIGHT');
    assert.equal(messageStore.size, 0);
  });

  test('store failure releases the claim so a genuine retry succeeds', async () => {
    const handleId = await issueHandle();
    const failingStore = new Proxy(messageStore, {
      get(target, prop, receiver) {
        if (prop === 'append') {
          return () => {
            throw new Error('store exploded');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const flaky = new sendMod.SendService({ messageStore: failingStore, handles, ledger, events });
    await assert.rejects(flaky.send(CTX, draftFor(handleId)), /store exploded/);
    // retry on the healthy service with the SAME idempotencyKey must succeed
    const receipt = await service.send(CTX, draftFor(handleId));
    assert.equal(receipt.revision, 1);
  });

  test('crash between persist and emit converges on retry (D-3): same message, event emitted once', async () => {
    const handleId = await issueHandle();
    const crashingEvents = new Proxy(events, {
      get(target, prop, receiver) {
        if (prop === 'append') {
          return () => {
            throw new Error('crash before emit');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const crashy = new sendMod.SendService({ messageStore, handles, ledger, events: crashingEvents });
    await assert.rejects(crashy.send(CTX, draftFor(handleId)), /crash before emit/);
    assert.equal(messageStore.size, 1, 'message persisted before the crash');

    const receipt = await service.send(CTX, draftFor(handleId));
    assert.equal(messageStore.size, 1, 'retry reuses the persisted message (store idempotency)');
    const logged = await events.readAfter('thread-1', 0, 10);
    assert.equal(logged.length, 1, 'exactly one publish event after recovery');
    assert.equal(logged[0].envelope.messageId, receipt.messageId);
  });

  test('cross-instance handle → PERMISSION end-to-end', async () => {
    const handleId = await issueHandle();
    await expectCode(service.send({ pluginInstanceId: 'inst-b' }, draftFor(handleId)), 'PERMISSION');
  });

  test('INV-1: a settled retry returns the original receipt after handle revocation', async () => {
    const handleId = await issueHandle();
    const draft = draftFor(handleId);
    const first = await service.send(CTX, draft);
    await handles.revoke(handleId);
    assert.deepEqual(await service.send(CTX, draft), first);
  });

  test('store idempotency keys encode instance and caller key segments independently', async () => {
    const firstHandle = await handles.issueThreadHandle({
      pluginInstanceId: 'inst:a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: { canSend: true, canSubscribe: false },
    });
    const secondHandle = await handles.issueThreadHandle({
      pluginInstanceId: 'inst',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: { canSend: true, canSubscribe: false },
    });
    const first = await service.send(
      { pluginInstanceId: 'inst:a' },
      draftFor(firstHandle.handleId, { idempotencyKey: 'b' }),
    );
    const second = await service.send(
      { pluginInstanceId: 'inst' },
      draftFor(secondHandle.handleId, { idempotencyKey: 'a:b' }),
    );
    assert.notEqual(first.messageId, second.messageId);
  });

  test('invalid draft rejected before any side effect', async () => {
    await expectCode(service.send(CTX, { nope: true }), 'VALIDATION');
    assert.equal(messageStore.size, 0);
  });

  test('replyTo referencing another thread → VALIDATION (no cross-thread preview leak)', async () => {
    const foreign = messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'secret in another thread',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-OTHER',
    });
    const handleId = await issueHandle();
    await expectCode(service.send(CTX, draftFor(handleId, { replyTo: foreign.id })), 'VALIDATION');
  });

  test('replyTo referencing a missing message → VALIDATION; same-thread replyTo accepted', async () => {
    const handleId = await issueHandle();
    await expectCode(service.send(CTX, draftFor(handleId, { replyTo: 'msg-does-not-exist' })), 'VALIDATION');
    const parent = await service.send(CTX, draftFor(handleId, { idempotencyKey: 'parent-1' }));
    const reply = await service.send(CTX, draftFor(handleId, { idempotencyKey: 'child-1', replyTo: parent.messageId }));
    assert.equal(messageStore.getById(reply.messageId).replyTo, parent.messageId);
  });

  test('replyTo rejects unrevealed whispers, queued messages, system messages, and briefings', async () => {
    const handleId = await issueHandle();
    const base = { userId: 'user-1', catId: null, mentions: [], timestamp: Date.now(), threadId: 'thread-1' };
    const parents = [
      messageStore.append({
        ...base,
        content: 'secret',
        visibility: 'whisper',
        whisperTo: ['opus'],
      }),
      messageStore.append({ ...base, content: 'queued', deliveryStatus: 'queued' }),
      messageStore.append({ ...base, userId: 'system', content: 'system prompt' }),
      messageStore.append({ ...base, content: 'briefing', origin: 'briefing' }),
    ];
    for (const [index, parent] of parents.entries()) {
      // eslint-disable-next-line no-await-in-loop
      await expectCode(
        service.send(CTX, draftFor(handleId, { idempotencyKey: `unsafe-parent-${index}`, replyTo: parent.id })),
        'VALIDATION',
      );
    }
  });
});
