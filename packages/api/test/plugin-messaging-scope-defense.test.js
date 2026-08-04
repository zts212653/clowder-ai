/**
 * K-1 / F288 — MemoryHandleStore scope defensive copy (INV-22 parity)
 *
 * Memory must snapshot scope on write, matching Redis's serialization
 * behavior. Without this, a caller holding the original scope reference
 * can mutate it post-mint, silently changing the stored record's
 * authorization — an authorization-escalation bug that Redis is immune to.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

/** @type {typeof import('../dist/domains/messaging/stores/memory.js')} */
let memory;
/** @type {typeof import('../dist/domains/messaging/handles.js')} */
let handlesMod;
/** @type {typeof import('../dist/domains/messaging/ledger.js')} */
let ledgerMod;
/** @type {typeof import('../dist/domains/messaging/send-service.js')} */
let sendMod;
let MessageStore;

beforeEach(async () => {
  memory = await import('../dist/domains/messaging/stores/memory.js');
  handlesMod = await import('../dist/domains/messaging/handles.js');
  ledgerMod = await import('../dist/domains/messaging/ledger.js');
  sendMod = await import('../dist/domains/messaging/send-service.js');
  ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));
});

describe('MemoryHandleStore — scope defensive copy (INV-22)', () => {
  test('put() snapshots scope — caller mutation does not corrupt store', async () => {
    const store = new memory.MemoryHandleStore();
    const scope = { canSend: false, canSubscribe: true };
    await store.put({
      handleId: 'th_scope',
      kind: 'thread_handle',
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope,
      issuedAt: 1,
    });
    // Mutate caller's scope AFTER put
    scope.canSend = true;
    const stored = await store.get('th_scope');
    assert.equal(stored.scope.canSend, false, 'stored scope must not reflect caller mutation');
  });

  test('getOrCreateMessageHandle snapshots scope on create path', async () => {
    const store = new memory.MemoryHandleStore();
    const scope = { canSend: true, canSubscribe: true };
    await store.getOrCreateMessageHandle({
      handleId: 'mh_scope',
      kind: 'message_handle',
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope,
      messageId: 'msg-scope',
      parentHandleId: 'th_parent',
      issuedAt: 1,
    });
    // Mutate CALLER's scope object after the store call
    scope.canSend = false;
    const stored = await store.get('mh_scope');
    assert.equal(stored.scope.canSend, true, 'stored scope must not reflect caller mutation');
  });
});

describe('Whisper target mutation defense (INV-22, service-level)', () => {
  test('caller .push() after issueThreadHandle does not widen whisper grant', async () => {
    const handles = new handlesMod.HandleService(new memory.MemoryHandleStore(), new memory.MemoryCursorStore());
    const service = new sendMod.SendService({
      messageStore: new MessageStore(),
      handles,
      ledger: new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore()),
      events: new memory.MemoryEventLogStore(),
      isKnownCatId: () => true,
    });

    // Issue handle — whisper grant restricted to ['opus'] only
    const targets = ['opus'];
    const { handleId } = await handles.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: { canSend: true, canSubscribe: true, allowedWhisperTargets: targets },
    });

    // Caller-side mutation AFTER issuance: without cloneScope this silently
    // widens the stored grant — an authorization-escalation bug (INV-22).
    targets.push('codex');

    // Whisper to 'codex' must fail — 'codex' was never in the granted set
    await assert.rejects(
      service.send(
        { pluginInstanceId: 'inst-a' },
        {
          address: { kind: 'thread_handle', handle: handleId },
          idempotencyKey: 'whisper-escalation-1',
          payload: {
            provenance: { epistemicStatus: 'inference' },
            elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'hi' } }],
          },
          draftAudience: { kind: 'whisper', targets: ['codex'] },
        },
      ),
      (err) => {
        assert.equal(err.name, 'MessagingError');
        assert.equal(err.code, 'PERMISSION');
        return true;
      },
    );
  });
});
