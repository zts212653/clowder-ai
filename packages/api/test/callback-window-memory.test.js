import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { readCallbackMessageWindow } from '../dist/routes/callback-visible-history.js';

function append(store, content, timestamp, userId = 'owner') {
  return store.append({
    userId,
    threadId: 'thread',
    from: { kind: 'user', userId },
    content,
    mentions: [],
    timestamp,
  });
}

test('memory before windows retain full bodies at an old anchor with more than one batch of newer rows', async () => {
  const store = new MessageStore();
  const rows = Array.from({ length: 65 }, (_, i) => append(store, `message ${i}`, i + 1));
  const before = await readCallbackMessageWindow({
    store,
    threadId: 'thread',
    userId: 'owner',
    anchor: rows[5],
    direction: 'before',
    count: 3,
    include: () => true,
  });
  assert.deepEqual(
    before.map((message) => message.content),
    ['message 2', 'message 3', 'message 4'],
  );
});

test('memory before windows advance through owner-invisible batches to earlier history', async () => {
  const store = new MessageStore();
  const older = append(store, 'full older body', 1);
  for (let i = 0; i < 60; i += 1) append(store, `foreign ${i}`, i + 2, 'foreign');
  const anchor = append(store, 'anchor', 100);
  const before = await readCallbackMessageWindow({
    store,
    threadId: 'thread',
    userId: 'owner',
    anchor,
    direction: 'before',
    count: 1,
    include: () => true,
  });
  assert.deepEqual(
    before.map((message) => message.id),
    [older.id],
  );
  assert.equal(before[0].content, 'full older body');
});
