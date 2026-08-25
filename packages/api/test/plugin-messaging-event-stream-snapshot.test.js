/**
 * K-1 / F288 — event stream subscriptions (plan Task 6, §4b)
 * AC-3: durable ack cursor, at-least-once redelivery (INV-4), opaque
 * subscription-local token (INV-5), stale + snapshot catch-up (INV-9).
 * Real stack; events produced via real SendService.
 */
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
let handleStore;
let cursors;
let events;
let sendService;
let stream;

const RETENTION = 5;
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
  handleStore = new memory.MemoryHandleStore();
  handles = new handlesMod.HandleService(handleStore, cursors);
  events = new memory.MemoryEventLogStore();
  sendService = new sendMod.SendService({
    messageStore,
    handles,
    ledger: new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore()),
    events,
    retentionCount: RETENTION,
    isKnownCatId: (catId) => catId === 'opus',
  });
  stream = new streamMod.EventStreamService({
    events,
    cursors,
    handles,
    messageStore,
  });
});

async function issueHandle(scope = { canSend: true, canSubscribe: true }) {
  const { handleId } = await handles.issueThreadHandle({
    pluginInstanceId: 'inst-a',
    threadId: 'thread-1',
    userId: 'user-1',
    scope,
  });
  return handleId;
}

async function sendN(handleId, n, prefix = 'msg') {
  for (let i = 1; i <= n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await sendService.send(CTX, {
      address: { kind: 'thread_handle', handle: handleId },
      idempotencyKey: `${prefix}-${i}`,
      payload: {
        provenance: { epistemicStatus: 'inference' },
        elements: [{ elementId: 'el-1', kind: 'text', payload: { text: `${prefix} ${i}` } }],
      },
    });
  }
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

describe('EventStreamService — stale + snapshot (INV-9)', () => {
  test('invalid historical payload fails before snapshot entitlement or cursor movement', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '[rich_block:el-invalid]',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-1',
      extra: {
        pluginMessage: {
          instanceId: CTX.pluginInstanceId,
          revision: 1,
          provenance: {
            origin: { kind: 'plugin', instanceId: CTX.pluginInstanceId },
            epistemicStatus: 'inference',
          },
          elements: [{ elementId: 'el-invalid', kind: 'rich_block', payload: { value: Number.NaN } }],
          outputRevision: 1,
          outputSequence: 1,
          appendOps: [],
        },
      },
    });
    const before = await cursors.get(CTX.pluginInstanceId, subscriptionId);

    await expectCode(stream.snapshotPage(CTX, { subscriptionId, maxItems: 1 }), 'VALIDATION');

    const after = await cursors.get(CTX.pluginInstanceId, subscriptionId);
    assert.deepEqual(after, before, 'invalid history cannot publish a view or move live cursor watermarks');
  });

  test('snapshot refuses a persisted plugin message until its publish event is inside the fence', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    let releaseEvent;
    let markEventBlocked;
    const eventBlocked = new Promise((resolve) => {
      markEventBlocked = resolve;
    });
    const eventGate = new Promise((resolve) => {
      releaseEvent = resolve;
    });
    const gatedEvents = new Proxy(events, {
      get(target, prop, receiver) {
        if (prop === 'append') {
          return async (...args) => {
            markEventBlocked();
            await eventGate;
            return target.append(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const gatedSend = new sendMod.SendService({
      messageStore,
      handles,
      ledger: new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore()),
      events: gatedEvents,
    });

    const pendingSend = gatedSend.send(CTX, {
      address: { kind: 'thread_handle', handle: handleId },
      idempotencyKey: 'snapshot-pending-publish',
      payload: {
        provenance: { epistemicStatus: 'inference' },
        elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'pending publish' } }],
      },
    });
    await eventBlocked;
    await expectCode(stream.snapshot(CTX, subscriptionId), 'RETRYABLE_INFLIGHT');
    releaseEvent();
    const sent = await pendingSend;
    const result = await stream.snapshot(CTX, subscriptionId);
    assert.equal(result.resumeSequence, sent.publishSequence);
    assert.deepEqual(
      result.envelopes.map((envelope) => envelope.messageId),
      [sent.messageId],
    );
  });

  test('snapshot excludes host messages outside the plugin event domain', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    // Insert host-only messages that have no corresponding plugin event.
    for (let index = 0; index < 205; index += 1) {
      messageStore.append({
        userId: 'user-1',
        catId: null,
        content: `host message ${index}`,
        mentions: [],
        timestamp: Date.now() + index,
        threadId: 'thread-1',
      });
    }
    // Send one plugin message (tracked by the event log).
    await sendService.send(CTX, {
      address: { kind: 'thread_handle', handle: handleId },
      idempotencyKey: 'plugin-msg-among-host',
      payload: {
        provenance: { epistemicStatus: 'inference' },
        elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'plugin only' } }],
      },
    });
    const result = await stream.snapshot(CTX, subscriptionId);
    // Only the plugin message appears; all 205 host messages are excluded
    // because their mutations are not represented by the plugin event log.
    assert.equal(result.envelopes.length, 1);
    assert.equal(result.envelopes[0].payload.elements[0].payload.text, 'plugin only');
    assert.equal(result.resumeSequence, 1);
  });

  test('snapshot refuses an append revision until its output event is inside the fence', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    const sent = await sendService.send(CTX, {
      address: { kind: 'thread_handle', handle: handleId },
      idempotencyKey: 'snapshot-pending-append-base',
      payload: {
        provenance: { epistemicStatus: 'inference' },
        elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'base' } }],
      },
    });
    let releaseEvent;
    let markEventBlocked;
    const eventBlocked = new Promise((resolve) => {
      markEventBlocked = resolve;
    });
    const eventGate = new Promise((resolve) => {
      releaseEvent = resolve;
    });
    const gatedEvents = new Proxy(events, {
      get(target, prop, receiver) {
        if (prop === 'append') {
          return async (...args) => {
            if (args[2].type === 'message.elements.append') {
              markEventBlocked();
              await eventGate;
            }
            return target.append(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const append = new appendMod.AppendService({
      messageStore,
      handles,
      ledger: new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore()),
      events: gatedEvents,
      appendLock: new memory.MemoryAppendLock(),
    });
    const pendingAppend = append.appendElements(CTX, {
      handle: sent.messageHandle,
      operationId: 'snapshot-pending-append',
      elements: [{ elementId: 'el-2', kind: 'text', payload: { text: 'pending append' } }],
    });
    await eventBlocked;
    await expectCode(stream.snapshot(CTX, subscriptionId), 'RETRYABLE_INFLIGHT');
    releaseEvent();
    await pendingAppend;
    const result = await stream.snapshot(CTX, subscriptionId);
    assert.equal(result.envelopes[0].revision, 2);
    assert.equal(result.resumeSequence, 2);
  });

  test('cursor behind retention floor → stale read with zero events, never silent skip', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    await sendN(handleId, RETENTION + 3); // events 1..8, retained 4..8, cursor at 0
    const result = await stream.read(CTX, subscriptionId, {});
    assert.equal(result.stale, true);
    assert.deepEqual(result.events, []);
    assert.equal(result.ackToken, null);
  });

  test('snapshot catches up: envelopes + resumeSequence; subsequent reads resume live', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    await sendN(handleId, RETENTION + 3);
    const snap = await stream.snapshot(CTX, subscriptionId);
    assert.equal(snap.resumeSequence, RETENTION + 3);
    assert.equal(snap.envelopes.length, RETENTION + 3, 'snapshot returns thread messages as envelopes');
    const live = await stream.read(CTX, subscriptionId, {});
    assert.equal(live.stale, false);
    assert.deepEqual(live.events, []);
    await sendN(handleId, 1, 'fresh');
    const next = await stream.read(CTX, subscriptionId, {});
    assert.equal(next.events.length, 1);
  });

  test('snapshot excludes whisper and deleted messages (fail-closed visibility)', async () => {
    const handleId = await issueHandle({ canSend: true, canSubscribe: true, allowedWhisperTargets: ['opus'] });
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    await sendN(handleId, 1, 'public');
    await sendService.send(CTX, {
      address: { kind: 'thread_handle', handle: handleId },
      idempotencyKey: 'whisper-1',
      draftAudience: { kind: 'whisper', targets: ['opus'] },
      payload: {
        provenance: { epistemicStatus: 'inference' },
        elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'secret' } }],
      },
    });
    const deleted = await sendService.send(CTX, {
      address: { kind: 'thread_handle', handle: handleId },
      idempotencyKey: 'doomed-1',
      payload: {
        provenance: { epistemicStatus: 'inference' },
        elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'to delete' } }],
      },
    });
    messageStore.softDelete(deleted.messageId, 'user-1');
    const snap = await stream.snapshot(CTX, subscriptionId);
    const texts = snap.envelopes.map((e) => e.payload.elements[0].payload.text);
    assert.ok(texts.includes('public 1'));
    assert.ok(!texts.includes('secret'), 'whisper excluded from snapshot');
    assert.ok(!texts.includes('to delete'), 'deleted excluded from snapshot');
  });

  test('snapshot excludes all host messages including scheduler, system, and briefing', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    const base = { catId: null, mentions: [], timestamp: Date.now(), threadId: 'thread-1' };
    // All of these are host messages (no pluginMessage) — none belong in the
    // plugin snapshot regardless of their visibility category.
    messageStore.append({ ...base, userId: 'user-1', content: 'public user content' });
    messageStore.append({ ...base, userId: 'system', content: 'system prompt' });
    messageStore.append({ ...base, userId: 'scheduler', content: 'scheduler prompt' });
    messageStore.append({ ...base, userId: 'user-1', content: 'briefing prompt', origin: 'briefing' });
    messageStore.append({
      ...base,
      userId: 'user-1',
      content: 'hidden trigger',
      extra: { scheduler: { hiddenTrigger: true } },
    });
    // Send one plugin message to verify plugin content IS included.
    await sendService.send(CTX, {
      address: { kind: 'thread_handle', handle: handleId },
      idempotencyKey: 'plugin-among-host-plumbing',
      payload: {
        provenance: { epistemicStatus: 'inference' },
        elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'plugin visible' } }],
      },
    });
    const snap = await stream.snapshot(CTX, subscriptionId);
    const texts = snap.envelopes.map((envelope) => envelope.payload.elements[0]?.payload.text);
    assert.deepEqual(texts, ['plugin visible']);
  });

  test('race regression: host message injected during scan does not leak into plugin snapshot', async () => {
    // Deterministic RED→GREEN regression for the domain mismatch:
    // A host message appended between the message scan and the fence
    // validation must not appear in the snapshot. Before the fix, the
    // host message would pass through because headBefore === headAfter
    // (host messages don't advance the plugin event sequence).
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    // Send a plugin message so the snapshot has something to return.
    await sendService.send(CTX, {
      address: { kind: 'thread_handle', handle: handleId },
      idempotencyKey: 'pre-race-plugin',
      payload: {
        provenance: { epistemicStatus: 'inference' },
        elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'plugin before race' } }],
      },
    });
    // Proxy the messageStore to inject a host message during the scan.
    let scanCount = 0;
    const racingStore = new Proxy(messageStore, {
      get(target, prop, receiver) {
        if (prop === 'getByThreadAfter') {
          return (...args) => {
            const result = target.getByThreadAfter(...args);
            scanCount += 1;
            if (scanCount === 1) {
              // Inject a host message after the scan completes but before
              // the fence check. This host message has no plugin event.
              target.append({
                userId: 'user-1',
                catId: null,
                content: 'host message injected during scan',
                mentions: [],
                timestamp: Date.now(),
                threadId: 'thread-1',
              });
            }
            return result;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const racingStream = new streamMod.EventStreamService({
      events,
      cursors,
      handles,
      messageStore: racingStore,
    });
    const snap = await racingStream.snapshot(CTX, subscriptionId);
    // The host message must not appear — it's outside the plugin event domain.
    assert.equal(snap.envelopes.length, 1);
    assert.equal(snap.envelopes[0].payload.elements[0].payload.text, 'plugin before race');
    // The plugin event head is 1 (from the single send), and it correctly
    // fences the single plugin message.
    assert.equal(snap.resumeSequence, 1);
  });

  test('ack of previously delivered events stays valid across trim (can cure staleness)', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    await sendN(handleId, 2);
    const read1 = await stream.read(CTX, subscriptionId, {}); // delivered 1..2
    await sendN(handleId, RETENTION, 'more'); // total 7, retained 3..7 → floor 3
    await stream.ack(CTX, subscriptionId, read1.ackToken); // ack 2 → cursor 2 ≥ floor-1 (2)
    const result = await stream.read(CTX, subscriptionId, {});
    assert.equal(result.stale, false, 'ack of delivered events stays valid after trim');
    assert.deepEqual(
      result.events.map((e) => e.sequence),
      [3, 4, 5, 6, 7],
    );
  });
});
