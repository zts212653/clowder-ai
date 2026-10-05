import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { persistLiveTranscriptItem, persistLiveUserText } from '../src/domains/concierge/live/live-transcript.js';
import { projectLiveTranscript } from '../src/domains/concierge/live/live-transcript-projection.js';

const scope = { userId: 'owner', threadId: 'home', callId: 'call-one' };
const binding = { ...scope, catId: createCatId('codex-astra'), nativeThreadId: 'native', realtimeSessionId: 'rtc' };
const speech = (id: string, role: string, text = 'same words') => ({
  method: 'thread/realtime/item/completed',
  params: { threadId: 'native', item: { id, role, text, type: 'transcriptSegment', realtimeSessionId: 'rtc' } },
});

test('only explicitly sourced same-call voice and typing enter captions, in stored source order', async () => {
  const store = new MessageStore();
  const input = await persistLiveTranscriptItem(store, binding, speech('input-one', 'user'));
  const typed = await persistLiveUserText(store, scope, 'same words', 'client-one');
  const output = await persistLiveTranscriptItem(store, binding, speech('output-one', 'assistant'));
  await persistLiveTranscriptItem(
    store,
    { ...binding, nativeTurnId: 'turn' },
    {
      method: 'item/completed',
      params: {
        threadId: 'native',
        turnId: 'turn',
        item: { id: 'result-one', text: 'same words', type: 'agentMessage', phase: 'final_answer' },
      },
    },
  );
  await persistLiveTranscriptItem(store, { ...binding, callId: 'older-call' }, speech('older-input', 'user'));
  await store.appendIdempotent({
    userId: 'owner',
    threadId: 'home',
    catId: null,
    content: 'legacy typed',
    mentions: [],
    timestamp: Date.now(),
    idempotencyKey: 'legacy',
  });
  const rows = await store.getByThread('home', 32, 'owner');
  const projected = projectLiveTranscript(rows, scope);
  assert.deepEqual(
    projected.messages.map((row) => row.id),
    [input?.id, typed.message.id, output?.id],
  );
  assert.deepEqual(
    projected.messages.map((row) => row.source.kind),
    ['voice', 'typed', 'voice'],
  );
  assert.equal(projected.messages[0].source.nativeItemId, 'input-one');
  assert.equal(projected.messages[1].source.clientMessageId, 'client-one');
  assert.equal(projected.messages[0].role, 'user');
  assert.equal(projected.messages[2].role, 'assistant');
  assert.equal(projected.hasMore, false);
  assert.equal((await store.getByThread('home', 32, 'owner')).length, 6, 'complete chat retains all original records');
  assert.deepEqual(projectLiveTranscript(rows, { ...scope, userId: 'foreign' }).messages, []);
  assert.deepEqual(projectLiveTranscript(rows, { ...scope, threadId: 'foreign' }).messages, []);
});

test('replay never duplicates captions; bounds explain omitted rows and text without reordering', async () => {
  const store = new MessageStore();
  for (let index = 0; index < 35; index++) await persistLiveUserText(store, scope, 'same words', `client-${index}`);
  await persistLiveUserText(store, scope, 'same words', 'client-34');
  const rows = await store.getByThread('home', 100, 'owner');
  const bounded = projectLiveTranscript(rows, scope);
  assert.equal(bounded.messages.length, 32);
  assert.equal(bounded.messages[0].id, rows[3].id);
  assert.equal(bounded.hasMore, true);
  assert.equal(projectLiveTranscript(rows.slice(-1), scope, true).hasMore, true);
  await persistLiveTranscriptItem(store, binding, speech('long', 'assistant', 'x'.repeat(32000)));
  const textBounded = projectLiveTranscript(await store.getByThread('home', 100, 'owner'), scope);
  assert.ok(textBounded.messages.reduce((sum, row) => sum + row.text.length, 0) <= 24000);
  assert.equal(textBounded.hasMore, true);
  assert.equal(textBounded.messages.at(-1)?.truncated, true);
});
