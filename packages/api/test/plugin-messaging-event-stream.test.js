/**
 * K-1 / F288 — event stream subscriptions (plan Task 6, §4b)
 * AC-3: durable ack cursor, at-least-once redelivery (INV-4), opaque
 * subscription-local token (INV-5), stale + snapshot catch-up (INV-9).
 * Real stack; events produced via real SendService.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import {
  MESSAGING_ROW_ENCODED_BYTE_BOUNDS,
  READ_ACK_TOKEN_MAX_LENGTH,
  REQUEST_ID_MAX_LENGTH,
} from '@clowder-ai/plugin-contract';

let memory;
let handlesMod;
let ledgerMod;
let sendMod;
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

async function sendLargeEvents(handleId, count) {
  const text = 'x'.repeat(60_000);
  for (let index = 1; index <= count; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await sendService.send(CTX, {
      address: { kind: 'thread_handle', handle: handleId },
      idempotencyKey: `large-event-${index}`,
      payload: {
        provenance: { epistemicStatus: 'inference' },
        elements: Array.from({ length: 4 }, (_, elementIndex) => ({
          elementId: `large-${index}-${elementIndex}`,
          kind: 'text',
          payload: { text },
        })),
      },
    });
  }
}

function encodedResultBytes(result) {
  return Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 'r'.repeat(REQUEST_ID_MAX_LENGTH), result }), 'utf8');
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

describe('EventStreamService — subscribe', () => {
  test('subscribe starts at current head: only future events delivered', async () => {
    const handleId = await issueHandle();
    await sendN(handleId, 2, 'before');
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    const empty = await stream.read(CTX, subscriptionId, {});
    assert.deepEqual(empty.events, []);
    assert.equal(empty.ackToken, null);
    await sendN(handleId, 1, 'after');
    const next = await stream.read(CTX, subscriptionId, {});
    assert.equal(next.events.length, 1);
    assert.equal(next.events[0].envelope.payload.elements[0].payload.text, 'after 1');
  });

  test('subscribe is idempotent per (instance, handle)', async () => {
    const handleId = await issueHandle();
    const first = await stream.subscribe(CTX, handleId);
    const second = await stream.subscribe(CTX, handleId);
    assert.equal(second.subscriptionId, first.subscriptionId);
  });

  test('parallel subscribe calls converge on one live subscription', async () => {
    const handleId = await issueHandle();
    const results = await Promise.all(Array.from({ length: 20 }, () => stream.subscribe(CTX, handleId)));
    assert.equal(new Set(results.map((result) => result.subscriptionId)).size, 1);
  });

  test('subscribe without canSubscribe scope → PERMISSION', async () => {
    const handleId = await issueHandle({ canSend: true, canSubscribe: false });
    await expectCode(stream.subscribe(CTX, handleId), 'PERMISSION');
  });
});

describe('EventStreamService — read/ack (INV-4, INV-5)', () => {
  test('retention trim racing read surfaces stale instead of silently skipping trimmed events', async () => {
    const handleId = await issueHandle();
    const subscriptionId = 'sub_trim_race';
    await cursors.put({
      subscriptionId,
      pluginInstanceId: 'inst-a',
      handleId,
      threadId: 'thread-1',
      ackedSequence: 0,
      lastDeliveredSequence: 0,
    });
    let trimmed = false;
    const racingEvents = {
      async minSequence() {
        return trimmed ? 4 : 1;
      },
      async readAfter() {
        trimmed = true;
        return [{ eventId: 'ev-4', sequence: 4, type: 'message.publish', envelope: {} }];
      },
    };
    const racingStream = new streamMod.EventStreamService({
      events: racingEvents,
      cursors,
      handles,
      messageStore,
    });

    const result = await racingStream.read(CTX, subscriptionId, {});
    assert.equal(result.stale, true);
    assert.deepEqual(result.events, []);
  });

  test('INV-4: unacked events are redelivered; acked events are not', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    await sendN(handleId, 3);

    const first = await stream.read(CTX, subscriptionId, {});
    assert.equal(first.events.length, 3);
    const again = await stream.read(CTX, subscriptionId, {});
    assert.equal(again.events.length, 3, 'no ack → same events redelivered');

    await stream.ack(CTX, subscriptionId, again.ackToken);
    const after = await stream.read(CTX, subscriptionId, {});
    assert.deepEqual(after.events, [], 'acked events never redelivered on the same subscription');
  });

  test('read respects limit and delivers ascending', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    await sendN(handleId, 3);
    const page = await stream.read(CTX, subscriptionId, { limit: 2 });
    assert.deepEqual(
      page.events.map((e) => e.sequence),
      [1, 2],
    );
    await stream.ack(CTX, subscriptionId, page.ackToken);
    const rest = await stream.read(CTX, subscriptionId, {});
    assert.deepEqual(
      rest.events.map((e) => e.sequence),
      [3],
    );
  });

  test('read stops before the beta.11 encoded-result budget and advances only through the emitted prefix', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    await sendLargeEvents(handleId, 5);

    const page = await stream.read(CTX, subscriptionId, { limit: 32 });
    assert.ok(page.events.length > 0 && page.events.length < 5, 'a valid bounded prefix must be emitted');
    assert.ok(page.ackToken.length <= READ_ACK_TOKEN_MAX_LENGTH);
    assert.ok(
      encodedResultBytes(page) <= MESSAGING_ROW_ENCODED_BYTE_BOUNDS['messaging.read'].maxEncodedResultBytes,
      'the complete compact JSON-RPC result must fit the published row budget',
    );

    await stream.ack(CTX, subscriptionId, page.ackToken);
    const remaining = await stream.read(CTX, subscriptionId, { limit: 32 });
    assert.equal(remaining.events[0].sequence, page.events.at(-1).sequence + 1);
    assert.equal(page.events.length + remaining.events.length, 5);
  });

  test('read never returns more than the C-1 maximum of 32 events', async () => {
    const handleId = await issueHandle();
    const subscriptionId = 'sub_contract_read_bound';
    await cursors.put({
      subscriptionId,
      pluginInstanceId: 'inst-a',
      handleId,
      threadId: 'thread-1',
      ackedSequence: 0,
      lastDeliveredSequence: 0,
    });
    const manyEvents = Array.from({ length: 50 }, (_, index) => ({
      eventId: `ev-${index + 1}`,
      sequence: index + 1,
      type: 'message.publish',
      envelope: {},
    }));
    const wideStream = new streamMod.EventStreamService({
      events: {
        async readAfter(_threadId, _afterSequence, limit) {
          return manyEvents.slice(0, limit);
        },
        async minSequence() {
          return 1;
        },
      },
      cursors,
      handles,
      messageStore,
    });
    const page = await wideStream.read(CTX, subscriptionId, { limit: 500 });
    assert.equal(page.events.length, 32);
  });

  test('read rejects non-finite, fractional, and non-positive limits', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0, -1]) {
      // eslint-disable-next-line no-await-in-loop
      await expectCode(stream.read(CTX, subscriptionId, { limit }), 'VALIDATION');
    }
  });

  test('INV-5: ack token from subscription A rejected on subscription B', async () => {
    const handleA = await issueHandle();
    const issuedB = await handles.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-2',
      userId: 'user-1',
      scope: { canSend: false, canSubscribe: true },
    });
    const subA = await stream.subscribe(CTX, handleA);
    const subB = await stream.subscribe(CTX, issuedB.handleId);
    await sendN(handleA, 1);
    const readA = await stream.read(CTX, subA.subscriptionId, {});
    await expectCode(stream.ack(CTX, subB.subscriptionId, readA.ackToken), 'VALIDATION');
  });

  test('malformed or forged tokens rejected', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    await sendN(handleId, 1);
    await stream.read(CTX, subscriptionId, {});
    await expectCode(stream.ack(CTX, subscriptionId, 'garbage-token'), 'VALIDATION');
    const forged = Buffer.from(JSON.stringify({ s: subscriptionId, q: 999, n: 'x' })).toString('base64url');
    await expectCode(stream.ack(CTX, subscriptionId, forged), 'PERMISSION');
  });

  test('unknown subscription → NOT_FOUND; foreign instance → NOT_FOUND scope', async () => {
    await expectCode(stream.read(CTX, 'sub_missing', {}), 'NOT_FOUND');
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    await expectCode(stream.read({ pluginInstanceId: 'inst-b' }, subscriptionId, {}), 'NOT_FOUND');
  });

  test('read on revoked subscription (handle revoke cascade) → PERMISSION', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    await handles.revoke(handleId);
    await expectCode(stream.read(CTX, subscriptionId, {}), 'PERMISSION');
    await expectCode(stream.subscribe(CTX, handleId), 'PERMISSION');
  });

  test('read re-checks handle liveness when the revocation cascade was interrupted', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    await handleStore.revoke(handleId, Date.now()); // simulate crash before cursors.revokeByHandle
    assert.equal((await cursors.get('inst-a', subscriptionId)).revokedAt, undefined);
    await expectCode(stream.read(CTX, subscriptionId, {}), 'PERMISSION');
  });
});
