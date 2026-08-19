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

describe('SendService — happy path (AC-1/AC-2)', () => {
  test('send persists message, emits publish event, returns receipt', async () => {
    const handleId = await issueHandle();
    const receipt = await service.send(CTX, draftFor(handleId));

    assert.equal(receipt.threadId, 'thread-1');
    assert.equal(receipt.revision, 1);
    assert.equal(receipt.publishSequence, 1);

    const stored = messageStore.getById(receipt.messageId);
    assert.ok(stored, 'message persisted in the message store');
    assert.equal(stored.content, 'hello from plugin');
    assert.equal(stored.userId, 'user-1');
    assert.equal(stored.catId, null);
    assert.deepEqual(stored.mentions, []);
    assert.equal(stored.extra.pluginMessage.instanceId, 'inst-a');
    assert.equal(stored.extra.pluginMessage.revision, 1);
    assert.deepEqual(stored.extra.pluginMessage.appendOps, []);
    // D-4: origin host-stamped
    assert.deepEqual(stored.extra.pluginMessage.provenance.origin, { kind: 'plugin', instanceId: 'inst-a' });

    const logged = await events.readAfter('thread-1', 0, 10);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].type, 'message.publish');
    assert.equal(logged[0].envelope.messageId, receipt.messageId);
    assert.deepEqual(logged[0].envelope.actor, { kind: 'plugin', id: 'inst-a' });
  });

  test('canonical payload trace fields survive persistence and envelope projection', async () => {
    const handleId = await issueHandle();
    const receipt = await service.send(
      CTX,
      draftFor(handleId, {
        sourceEventId: 'github:issue:42',
        payload: {
          provenance: { epistemicStatus: 'inference' },
          elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'trace me' } }],
          correlationId: 'corr-7',
          causationId: 'cause-6',
        },
      }),
    );

    const stored = messageStore.getById(receipt.messageId);
    assert.equal(stored.extra.pluginMessage.sourceEventId, 'github:issue:42');
    assert.equal(stored.extra.pluginMessage.correlationId, 'corr-7');
    assert.equal(stored.extra.pluginMessage.causationId, 'cause-6');
    const [event] = await events.readAfter('thread-1', 0, 10);
    assert.equal(event.envelope.payload.correlationId, 'corr-7');
    assert.equal(event.envelope.payload.causationId, 'cause-6');
  });

  test('INV-1: same idempotencyKey returns identical receipt; exactly one message + one event', async () => {
    const handleId = await issueHandle();
    const first = await service.send(CTX, draftFor(handleId));
    const second = await service.send(CTX, draftFor(handleId));
    assert.deepEqual(second, first);
    assert.equal(messageStore.size, 1);
    assert.equal((await events.readAfter('thread-1', 0, 10)).length, 1);
  });

  test('different idempotencyKeys create distinct messages with monotonic sequences', async () => {
    const handleId = await issueHandle();
    const r1 = await service.send(CTX, draftFor(handleId, { idempotencyKey: 'a' }));
    const r2 = await service.send(CTX, draftFor(handleId, { idempotencyKey: 'b' }));
    assert.notEqual(r1.messageId, r2.messageId);
    assert.deepEqual([r1.publishSequence, r2.publishSequence], [1, 2]);
  });

  test('non-text elements render as plaintext markers in content', async () => {
    const handleId = await issueHandle();
    const receipt = await service.send(
      CTX,
      draftFor(handleId, {
        payload: {
          provenance: { epistemicStatus: 'inference' },
          elements: [
            { elementId: 'el-1', kind: 'text', payload: { text: 'caption' } },
            { elementId: 'el-2', kind: 'media_ref', payload: { url: 'file://x.png' } },
          ],
        },
      }),
    );
    const stored = messageStore.getById(receipt.messageId);
    assert.equal(stored.content, 'caption\n[media_ref:el-2]');
  });
});

describe('SendService — whisper (grant enforcement + v0 stream boundary)', () => {
  test('whisper within allowed targets maps to whisper visibility; no publish event; no publishSequence', async () => {
    const handleId = await issueHandle({
      canSend: true,
      canSubscribe: false,
      allowedWhisperTargets: ['opus', 'codex'],
    });
    const receipt = await service.send(
      CTX,
      draftFor(handleId, { draftAudience: { kind: 'whisper', targets: ['opus'] } }),
    );
    assert.equal(receipt.publishSequence, undefined);
    const stored = messageStore.getById(receipt.messageId);
    assert.equal(stored.visibility, 'whisper');
    assert.deepEqual(stored.whisperTo, ['opus']);
    assert.deepEqual(await events.readAfter('thread-1', 0, 10), []);
  });

  test('whisper outside the allowed set → PERMISSION', async () => {
    const handleId = await issueHandle({ canSend: true, canSubscribe: false, allowedWhisperTargets: ['opus'] });
    await expectCode(
      service.send(CTX, draftFor(handleId, { draftAudience: { kind: 'whisper', targets: ['opus', 'codex'] } })),
      'PERMISSION',
    );
  });

  test('whisper with no whisper grant at all → PERMISSION', async () => {
    const handleId = await issueHandle({ canSend: true, canSubscribe: false });
    await expectCode(
      service.send(CTX, draftFor(handleId, { draftAudience: { kind: 'whisper', targets: ['opus'] } })),
      'PERMISSION',
    );
  });

  test('unknown whisper targets are rejected even if a malformed handle grant lists them', async () => {
    const handleId = await issueHandle({
      canSend: true,
      canSubscribe: false,
      allowedWhisperTargets: ['not-a-real-cat'],
    });
    await expectCode(
      service.send(CTX, draftFor(handleId, { draftAudience: { kind: 'whisper', targets: ['not-a-real-cat'] } })),
      'PERMISSION',
    );
  });
});

describe('SendService — D-4 origin stamping', () => {
  test('thread_handle send declaring a foreign plugin origin → PERMISSION', async () => {
    const handleId = await issueHandle();
    await expectCode(
      service.send(
        CTX,
        draftFor(handleId, {
          payload: {
            provenance: { epistemicStatus: 'inference', origin: { kind: 'plugin', instanceId: 'inst-evil' } },
            elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'x' } }],
          },
        }),
      ),
      'PERMISSION',
    );
  });

  test('thread_handle send declaring external origin → PERMISSION (needs a connector binding)', async () => {
    const handleId = await issueHandle();
    await expectCode(
      service.send(
        CTX,
        draftFor(handleId, {
          payload: {
            provenance: { epistemicStatus: 'user_intent', origin: { kind: 'external', connectorId: 'telegram' } },
            elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'x' } }],
          },
        }),
      ),
      'PERMISSION',
    );
  });

  test('connector_binding send with matching external origin carries sourceAddress into the envelope', async () => {
    const { handleId } = await handles.issueConnectorBindingHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: { canSend: true, canSubscribe: false },
      connectorId: 'telegram',
      externalChatId: 'chat-9',
    });
    const receipt = await service.send(CTX, {
      address: { kind: 'connector_binding', handle: handleId },
      idempotencyKey: 'idem-ext',
      sourceEventId: 'tg-evt-1',
      payload: {
        provenance: {
          epistemicStatus: 'user_intent',
          origin: {
            kind: 'external',
            connectorId: 'telegram',
            sourceAddress: { connectorId: 'telegram', chatId: 'chat-9', messageId: 'tg-msg-7' },
          },
        },
        elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'relayed from telegram' } }],
      },
    });
    const stored = messageStore.getById(receipt.messageId);
    assert.deepEqual(stored.extra.pluginMessage.provenance.origin, {
      kind: 'external',
      connectorId: 'telegram',
      sourceAddress: { connectorId: 'telegram', chatId: 'chat-9', messageId: 'tg-msg-7' },
    });
  });

  test('connector_binding send with mismatched connectorId or chatId → PERMISSION', async () => {
    const { handleId } = await handles.issueConnectorBindingHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: { canSend: true, canSubscribe: false },
      connectorId: 'telegram',
      externalChatId: 'chat-9',
    });
    const base = {
      address: { kind: 'connector_binding', handle: handleId },
      idempotencyKey: 'idem-x',
    };
    await expectCode(
      service.send(CTX, {
        ...base,
        payload: {
          provenance: { epistemicStatus: 'user_intent', origin: { kind: 'external', connectorId: 'feishu' } },
          elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'x' } }],
        },
      }),
      'PERMISSION',
    );
    await expectCode(
      service.send(CTX, {
        ...base,
        payload: {
          provenance: {
            epistemicStatus: 'user_intent',
            origin: {
              kind: 'external',
              connectorId: 'telegram',
              sourceAddress: { connectorId: 'telegram', chatId: 'chat-OTHER' },
            },
          },
          elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'x' } }],
        },
      }),
      'PERMISSION',
    );
    await expectCode(
      service.send(CTX, {
        ...base,
        payload: {
          provenance: {
            epistemicStatus: 'user_intent',
            origin: {
              kind: 'external',
              connectorId: 'telegram',
              sourceAddress: { connectorId: 'discord', chatId: 'chat-9' },
            },
          },
          elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'x' } }],
        },
      }),
      'PERMISSION',
    );
  });
});
