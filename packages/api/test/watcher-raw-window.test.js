import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { watcherRawWindow } from '../dist/domains/concierge/watcher/watcher-prompt.js';

async function add(store, content, timestamp) {
  return store.append({
    userId: 'u',
    threadId: 't',
    from: { kind: 'agent', catId: 'codex' },
    content,
    timestamp,
    mentions: [],
  });
}
test('a parallel reply that started earlier and finished later is still read, without moving the raw high water mark backwards', async () => {
  const messages = new MessageStore();
  const earlier = await add(messages, 'FINISHED_LATE', 100);
  const later = await add(messages, 'ALREADY_READ', 200);
  const window = await watcherRawWindow(
    messages,
    'u',
    't',
    { revision: 1, afterSequence: 1, notes: '', consumedThrough: later.id },
    earlier.id,
    300,
  );
  assert.ok(window.body.includes('FINISHED_LATE'));
  assert.equal(window.body.includes('ALREADY_READ'), false);
  assert.deepEqual(window.resumeCursor, { messageId: later.id, offset: 0 });
  assert.equal(window.complete, true);
});
test('first wake reads a recent bounded raw window, never messages newer than its actual settlement', async () => {
  const messages = new MessageStore();
  for (let i = 0; i < 30; i++) await add(messages, `PAST_${i}`, i + 1);
  await add(messages, 'FUTURE_PRIVATE_MESSAGE', 1000);
  const window = await watcherRawWindow(
    messages,
    'u',
    't',
    { revision: 0, afterSequence: 0, notes: '' },
    undefined,
    100,
  );
  assert.equal(window.body.includes('FUTURE_PRIVATE_MESSAGE'), false);
  assert.equal(window.body.includes('PAST_0\n'), false);
  assert.ok(window.body.includes('PAST_29'));
});

test('a no-response settlement stays incomplete until all original pages before its cutoff are delivered', async () => {
  const messages = new MessageStore();
  const baseline = await add(messages, 'BASELINE', 1);
  const ids = [];
  for (let i = 0; i < 45; i++) ids.push((await add(messages, `UNSEEN_${i}`, i + 2)).id);
  const state = { revision: 1, afterSequence: 1, notes: '', consumedThrough: baseline.id };
  const first = await watcherRawWindow(messages, 'u', 't', state, undefined, 100);
  assert.equal(first.complete, false);
  assert.equal(first.messageIds.length, 40);
  const second = await watcherRawWindow(
    messages,
    'u',
    't',
    { ...state, consumedThrough: first.frontier, messageOffset: first.offset },
    undefined,
    100,
  );
  assert.equal(second.complete, true);
  assert.deepEqual([...first.messageIds, ...second.messageIds], ids);
});

test('a later published message does not keep a no-response settlement open past its own cutoff', async () => {
  const messages = new MessageStore();
  const baseline = await add(messages, 'BASELINE', 1);
  for (let i = 0; i < 40; i++) await add(messages, `CURRENT_${i}`, i + 2);
  await add(messages, 'FUTURE_NOT_IN_THIS_SETTLEMENT', 1000);
  const window = await watcherRawWindow(
    messages,
    'u',
    't',
    { revision: 1, afterSequence: 1, notes: '', consumedThrough: baseline.id },
    undefined,
    100,
  );
  assert.equal(window.complete, true);
  assert.equal(window.body.includes('FUTURE_NOT_IN_THIS_SETTLEMENT'), false);
});

test('an excluded watcher-only page still advances the scan cursor toward the next ordinary original', async () => {
  const messages = new MessageStore();
  const baseline = await add(messages, 'BASELINE', 1);
  for (let i = 0; i < 45; i++)
    await messages.append({
      userId: 'u',
      threadId: 't',
      from: { kind: 'agent', catId: 'codex' },
      content: 'OBSERVER_OUTPUT',
      timestamp: i + 2,
      mentions: [],
      extra: {
        turnExecution: { invocationId: `watch-${i}`, parentInvocationId: `watch-${i}`, executionKind: 'watcher' },
      },
    });
  const ordinary = await add(messages, 'ACTUAL_UNREAD_ORIGINAL', 70);
  const state = { revision: 1, afterSequence: 1, notes: '', consumedThrough: baseline.id };
  const first = await watcherRawWindow(messages, 'u', 't', state, undefined, 100);
  assert.equal(first.complete, false);
  assert.notEqual(first.frontier, baseline.id);
  assert.equal(first.body, '');
  const second = await watcherRawWindow(
    messages,
    'u',
    't',
    { ...state, consumedThrough: first.frontier, messageOffset: first.offset },
    undefined,
    100,
  );
  assert.equal(second.complete, true);
  assert.deepEqual(second.messageIds, [ordinary.id]);
  assert.equal(second.body.includes('OBSERVER_OUTPUT'), false);
});

test('resuming inside a body still respects the forty-original checkpoint bound', async () => {
  const messages = new MessageStore();
  const baseline = await add(messages, 'BODY_REMAINDER', 1);
  for (let i = 0; i < 40; i++) await add(messages, `CURRENT_${i}`, i + 2);
  const window = await watcherRawWindow(
    messages,
    'u',
    't',
    { revision: 1, afterSequence: 1, notes: '', consumedThrough: baseline.id, messageOffset: 1 },
    undefined,
    100,
  );
  assert.equal(window.complete, false);
  assert.equal(window.messageIds.length, 40);
});
