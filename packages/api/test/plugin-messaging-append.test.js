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

/**
 * Build an append request. `handleOrToken` is either the SendReceipt's
 * MessageHandle object or a raw string token (for error-path tests with
 * fabricated/missing tokens).
 */
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

describe('AppendService — happy path (AC-4)', () => {
  test('append bumps revision, persists elements, emits append event', async () => {
    const sent = await sendMessage();
    const receipt = await service.appendElements(CTX, appendInput(sent.handle));

    assert.equal(receipt.messageId, sent.messageId);
    assert.equal(receipt.revision, 2);
    assert.deepEqual(receipt.appliedElementIds, ['el-2']);
    assert.equal(typeof receipt.appendSequence, 'number');

    const stored = messageStore.getById(sent.messageId);
    assert.equal(stored.extra.pluginMessage.revision, 2);
    assert.equal(stored.extra.pluginMessage.elements.length, 2);
    assert.deepEqual(stored.extra.pluginMessage.appendOps, [{ operationId: 'op-1', elementIds: ['el-2'] }]);
    assert.equal(stored.content, 'original', 'INV-6: original content untouched');

    const logged = await events.readAfter('thread-1', 0, 10);
    const appendEvents = logged.filter((e) => e.type === 'message.elements.append');
    assert.equal(appendEvents.length, 1);
    assert.equal(appendEvents[0].revision, 2);
    assert.equal(appendEvents[0].operationId, 'op-1');
  });

  test('appended elements default to inference (no silent inheritance of message-level status)', async () => {
    const sent = await sendMessage(); // message-level provenance: user_intent
    await service.appendElements(CTX, appendInput(sent.handle));
    const stored = messageStore.getById(sent.messageId);
    const appended = stored.extra.pluginMessage.elements.find((e) => e.elementId === 'el-2');
    assert.equal(appended.epistemicStatus, 'inference');
  });

  test('INV-12: same operationId replays to the same receipt without duplicating elements', async () => {
    const sent = await sendMessage();
    const first = await service.appendElements(CTX, appendInput(sent.handle));
    const replay = await service.appendElements(CTX, appendInput(sent.handle));
    assert.deepEqual(replay, first);
    assert.equal(messageStore.getById(sent.messageId).extra.pluginMessage.elements.length, 2);
  });

  test('sequential appends serialize: revisions 2 then 3', async () => {
    const sent = await sendMessage();
    const r1 = await service.appendElements(CTX, appendInput(sent.handle, { operationId: 'op-1' }));
    const r2 = await service.appendElements(
      CTX,
      appendInput(sent.handle, {
        operationId: 'op-2',
        elements: [{ elementId: 'el-3', kind: 'text', payload: { text: 'third' } }],
      }),
    );
    assert.equal(r1.revision, 2);
    assert.equal(r2.revision, 3);
    assert.deepEqual(messageStore.getById(sent.messageId).extra.pluginMessage.appendOps, [
      { operationId: 'op-1', elementIds: ['el-2'] },
      { operationId: 'op-2', elementIds: ['el-3'] },
    ]);
  });

  test('derivedFromElementId referencing a persisted element is accepted', async () => {
    const sent = await sendMessage();
    const receipt = await service.appendElements(
      CTX,
      appendInput(sent.handle, {
        elements: [{ elementId: 'el-2', kind: 'text', payload: { text: 'summary' }, derivedFromElementId: 'el-1' }],
      }),
    );
    assert.equal(receipt.revision, 2);
  });
});

describe('AppendService — INV-7 provenance whitewash guard', () => {
  test('non-inference claim without derivation → PERMISSION', async () => {
    const sent = await sendMessage();
    await expectCode(
      service.appendElements(
        CTX,
        appendInput(sent.handle, {
          elements: [{ elementId: 'el-2', kind: 'text', payload: { text: 'x' }, epistemicStatus: 'observation' }],
        }),
      ),
      'PERMISSION',
    );
  });

  test('claim equal to the derived-from element status is allowed; elevation is not', async () => {
    const sent = await sendMessage(); // el-1 inherits message-level user_intent
    const ok = await service.appendElements(
      CTX,
      appendInput(sent.handle, {
        operationId: 'op-eq',
        elements: [
          {
            elementId: 'el-2',
            kind: 'text',
            payload: { text: 'quoted' },
            epistemicStatus: 'user_intent',
            derivedFromElementId: 'el-1',
          },
        ],
      }),
    );
    assert.equal(ok.revision, 2);
    await expectCode(
      service.appendElements(
        CTX,
        appendInput(sent.handle, {
          operationId: 'op-elevate',
          elements: [
            {
              elementId: 'el-3',
              kind: 'text',
              payload: { text: 'inference→observation' },
              epistemicStatus: 'observation',
              derivedFromElementId: 'el-2',
            },
          ],
        }),
      ),
      'PERMISSION',
    );
  });
});

describe('AppendService — validation and lock guards (§4d)', () => {
  test('C-1 envelope bound: cumulative appends cannot exceed maxElementsPerMessage', async () => {
    // beta.5 raised maxElementsPerMessage from 32 → 128; per-operation cap stays 32.
    // Build up to 128 via send(32) + 3 × append(32), then verify one more is rejected.
    const initialElements = Array.from({ length: 32 }, (_, index) => ({
      elementId: `el-${index + 1}`,
      kind: 'text',
      payload: { text: `item ${index + 1}` },
    }));
    const sent = await sendMessage({
      payload: { provenance: { epistemicStatus: 'inference' }, elements: initialElements },
    });
    // Append 3 batches of 32 → 32 + 96 = 128 total
    for (let batch = 1; batch <= 3; batch++) {
      const batchElements = Array.from({ length: 32 }, (_, i) => ({
        elementId: `el-batch${batch}-${i}`,
        kind: 'text',
        payload: { text: `batch ${batch} item ${i}` },
      }));
      await service.appendElements(
        CTX,
        appendInput(sent.handle, {
          operationId: `op-batch-${batch}`,
          elements: batchElements,
        }),
      );
    }
    assert.equal(messageStore.getById(sent.messageId).extra.pluginMessage.elements.length, 128);
    // One more element should be rejected
    await expectCode(
      service.appendElements(
        CTX,
        appendInput(sent.handle, {
          operationId: 'op-overflow',
          elements: [{ elementId: 'el-overflow', kind: 'text', payload: { text: 'overflow' } }],
        }),
      ),
      'VALIDATION',
    );
    assert.equal(messageStore.getById(sent.messageId).extra.pluginMessage.elements.length, 128);
  });

  test('D-6: cumulative payload bytes are bounded across append operations', async () => {
    const initialElements = Array.from({ length: 4 }, (_, index) => ({
      elementId: `el-${index + 1}`,
      kind: 'text',
      payload: { text: 'x'.repeat(60 * 1024) },
    }));
    const sent = await sendMessage({
      payload: { provenance: { epistemicStatus: 'inference' }, elements: initialElements },
    });
    await expectCode(
      service.appendElements(
        CTX,
        appendInput(sent.handle, {
          elements: [{ elementId: 'el-overflow', kind: 'text', payload: { text: 'y'.repeat(20 * 1024) } }],
        }),
      ),
      'VALIDATION',
    );
    assert.equal(messageStore.getById(sent.messageId).extra.pluginMessage.elements.length, 4);
  });

  test('derivedFromElementId referencing a nonexistent element → VALIDATION', async () => {
    const sent = await sendMessage();
    await expectCode(
      service.appendElements(
        CTX,
        appendInput(sent.handle, {
          elements: [{ elementId: 'el-2', kind: 'text', payload: { text: 'x' }, derivedFromElementId: 'el-404' }],
        }),
      ),
      'VALIDATION',
    );
  });

  test('cross-instance append → PERMISSION', async () => {
    const sent = await sendMessage();
    await expectCode(service.appendElements({ pluginInstanceId: 'inst-b' }, appendInput(sent.handle)), 'PERMISSION');
  });

  test('a raw non-plugin message id is not an issued message handle', async () => {
    const user = messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'human words',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-1',
    });
    await expectCode(service.appendElements(CTX, appendInput(user.id)), 'NOT_FOUND');
  });

  test('append to unknown / deleted / tombstoned message → NOT_FOUND', async () => {
    await expectCode(service.appendElements(CTX, appendInput('msg-missing')), 'NOT_FOUND');
    const sent = await sendMessage();
    messageStore.softDelete(sent.messageId, 'user-1');
    await expectCode(service.appendElements(CTX, appendInput(sent.handle)), 'NOT_FOUND');
  });

  test('lock contention → RETRYABLE_INFLIGHT; released claim allows retry', async () => {
    const sent = await sendMessage();
    const token = await appendLock.acquire(sent.messageId, 60_000); // foreign lock holder
    await expectCode(service.appendElements(CTX, appendInput(sent.handle)), 'RETRYABLE_INFLIGHT');
    await appendLock.release(sent.messageId, token);
    const receipt = await service.appendElements(CTX, appendInput(sent.handle));
    assert.equal(receipt.revision, 2);
  });

  test('stale in-memory lock holder cannot release its successor', async () => {
    const lock = new memory.MemoryAppendLock();
    const staleToken = await lock.acquire('msg-lock', 0);
    const liveToken = await lock.acquire('msg-lock', 60_000);
    assert.equal(typeof staleToken.token, 'string');
    assert.equal(typeof liveToken.token, 'string');
    await lock.release('msg-lock', staleToken);
    assert.equal(await lock.acquire('msg-lock', 60_000), null, 'successor lock remains held');
    await lock.release('msg-lock', liveToken);
  });
});

describe('AppendService — whisper boundary (v0)', () => {
  test('append to a whisper message applies but is not event-streamed', async () => {
    const sent = await sendMessage({ draftAudience: { kind: 'whisper', targets: ['opus'] } });
    const receipt = await service.appendElements(CTX, appendInput(sent.handle));
    assert.equal(receipt.revision, 2);
    assert.equal(receipt.appendSequence, undefined);
    const logged = await events.readAfter('thread-1', 0, 10);
    assert.deepEqual(logged, [], 'whisper content never reaches the stream');
  });
});
