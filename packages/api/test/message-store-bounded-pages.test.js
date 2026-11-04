import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { getTimelineOrderTime } from '../dist/domains/cats/services/stores/visibility.js';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

const options = { artifactProjection: true, includeQueuedCatMessages: true };
const append = (store, timestamp, extra = {}) =>
  store.append(
    canonicalTestMessageInput({
      userId: 'u',
      catId: null,
      content: String(timestamp),
      mentions: [],
      threadId: 'T',
      timestamp,
      ...extra,
    }),
  );
const read = (store, timestamp = Number.MAX_SAFE_INTEGER, id, budget = 128) =>
  store.getByThreadBeforeBounded('T', timestamp, budget, id, 'u', budget, options);
const ids = (messages) => messages.map((message) => message.id);

// A 128-row page must not walk 700 source records and then report only the slice.
test('artifact pages do not traverse the global buffer before applying the raw budget', () => {
  const store = new MessageStore();
  const messages = Array.from({ length: 700 }, (_, i) => append(store, i, { threadId: i < 100 ? 'other' : 'T' }));
  let inspected = 0;
  for (const message of messages) {
    const threadId = message.threadId;
    Object.defineProperty(message, 'threadId', {
      get: () => {
        inspected++;
        return threadId;
      },
    });
  }
  const page = read(store);
  assert.ok(inspected <= 128, `raw preparation visited ${inspected} rows for a 128-row page`);
  assert.equal(page.scannedCount, 128);
  assert.equal(page.messages.length, 128);
  assert.equal(page.exhausted, false);
});

test('artifact pages resume equal-time and backdated messages after invisible raw rows', () => {
  const store = new MessageStore();
  const messages = Array.from({ length: 600 }, (_, i) =>
    append(store, (i * 37) % 41, {
      userId: i % 7 === 0 ? 'foreign' : 'u',
      ...(i % 9 === 0 ? { deliveryStatus: 'queued' } : {}),
    }),
  );
  store.softDelete(messages[10].id, 'u');
  const expected = store
    .getByThread('T', 1000, 'u', options)
    .sort((a, b) => getTimelineOrderTime(a) - getTimelineOrderTime(b) || (a.id < b.id ? -1 : 1));
  let page,
    cursor,
    scanned = 0;
  const seen = [];
  do {
    page = read(store, cursor?.timestamp, cursor?.id, 17);
    assert.ok(page.scannedCount <= 17);
    scanned += page.scannedCount;
    seen.unshift(...page.messages);
    assert.ok(page.exhausted || page.nextCursor);
    assert.notDeepEqual(page.nextCursor, cursor);
    cursor = page.nextCursor;
  } while (!page.exhausted);
  assert.equal(scanned, 600, 'foreign, queued and deleted rows consume the raw budget');
  assert.deepEqual(ids(seen), ids(expected));
  assert.equal(new Set(ids(seen)).size, seen.length);
});

test('artifact page positions follow delivery time and live deletion/restore without stale rows', () => {
  const store = new MessageStore();
  const queued = append(store, 10, { deliveryStatus: 'queued' });
  const middle = append(store, 20);
  assert.deepEqual(ids(read(store).messages), [middle.id]);
  store.markDelivered(queued.id, 30);
  const latest = read(store, 40, undefined, 1);
  assert.deepEqual(ids(latest.messages), [queued.id]);
  assert.equal(latest.nextCursor.timestamp, 30);
  assert.deepEqual(ids(read(store, latest.nextCursor.timestamp, latest.nextCursor.id).messages), [middle.id]);
  store.softDelete(middle.id, 'u');
  assert.deepEqual(ids(read(store).messages), [queued.id]);
  store.restore(middle.id);
  assert.deepEqual(ids(read(store).messages), [middle.id, queued.id]);
});

test('artifact index drops trimmed and deleted threads and keeps later reused thread data', () => {
  const store = new MessageStore({ maxMessages: 2 });
  append(store, 10);
  const middle = append(store, 20);
  const last = append(store, 30);
  assert.deepEqual(ids(read(store).messages), [middle.id, last.id]);
  assert.equal(store.deleteByThread('T'), 2);
  assert.deepEqual(read(store).messages, []);
  assert.equal(read(store).exhausted, true);
  const fresh = append(store, 5);
  assert.deepEqual(ids(read(store).messages), [fresh.id]);
});

test('artifact pages follow the canonical replacement when a lifecycle response completes', () => {
  const store = new MessageStore();
  const processing = append(store, 100, {
    catId: 'opus',
    content: '',
    lifecycle: {
      kind: 'response',
      orderKey: '0000000000100:response',
      invocationId: 'inv-1',
      targetId: 'opus',
      inputEntryIds: ['entry-1'],
      inputMessageIds: ['input-1'],
      status: 'processing',
      startedAt: 100,
    },
  });
  const applied = store.commitLifecycleResponseTerminal(processing.id, {
    invocationId: 'inv-1',
    status: 'completed',
    completedAt: 200,
    content: 'final body',
    mentions: [],
  });
  assert.equal(applied.kind, 'applied');
  const page = read(store);
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].content, 'final body');
  assert.equal(page.messages[0].lifecycle.status, 'completed');
});

test('artifact delivery keeps already published queued speech at its authoring time', () => {
  const store = new MessageStore();
  const queued = append(store, 10, { catId: 'opus', deliveryStatus: 'queued' });
  const later = append(store, 20);
  store.markDelivered(queued.id, 30);
  const page = read(store, 40);
  assert.deepEqual(ids(page.messages), [queued.id, later.id]);
  assert.equal(page.nextCursor.timestamp, 10);
});

// F332 / #1087 review: Redis serves both projections from the thread index and
// differs only in the selected hash fields; memory must not window the global
// log for one of them, or a quiet thread's rows vanish behind busy neighbours.
test('recipient pages read the same thread timeline as artifact pages', () => {
  const store = new MessageStore();
  append(store, 1);
  append(store, 2);
  for (let i = 0; i < 150; i++) append(store, 100 + i, { threadId: 'busy-neighbour' });
  const bounded = (projection) =>
    store.getByThreadBeforeBounded('T', Number.MAX_SAFE_INTEGER, 100, undefined, 'u', 100, projection);
  const recipient = bounded({ recipientProjection: true });
  const artifact = bounded({ artifactProjection: true });
  assert.equal(recipient.messages.length, 2, 'neighbour rows must not evict the quiet thread');
  assert.deepEqual(ids(recipient.messages), ids(artifact.messages));
  assert.equal(recipient.scannedCount, artifact.scannedCount);
  assert.equal(recipient.exhausted, true);
  assert.equal(recipient.exhausted, artifact.exhausted);
  assert.deepEqual(recipient.nextCursor, artifact.nextCursor);
  // The unprojected default keeps its F148 global-window accounting unchanged.
  const unprojected = bounded(undefined);
  assert.equal(unprojected.messages.length, 0);
  assert.equal(unprojected.scannedCount, 100);
  assert.equal(unprojected.exhausted, false);
});
