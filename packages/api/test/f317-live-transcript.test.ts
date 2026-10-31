import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId, createCompanionIdentitySnapshot } from '@cat-cafe/shared';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { persistLiveTranscriptItem, persistLiveUserText } from '../src/domains/concierge/live/live-transcript.js';

test('typed text has durable call/source identity; equal text and retries remain distinct by identity', async () => {
  const store = new MessageStore();
  const binding = { userId: 'owner', threadId: 'home', callId: 'call-one' };
  const first = await persistLiveUserText(store, binding, 'same words', 'client-one');
  const replay = await persistLiveUserText(store, binding, 'same words', 'client-one');
  const second = await persistLiveUserText(store, binding, 'same words', 'client-two');
  const nextCall = await persistLiveUserText(store, { ...binding, callId: 'call-two' }, 'same words', 'client-one');
  assert.deepEqual(first.message.extra?.liveCompanion, {
    modality: 'typed',
    role: 'user',
    callId: 'call-one',
    clientMessageId: 'client-one',
  });
  assert.equal(first.message.id, replay.message.id);
  assert.equal(replay.idempotent, true);
  assert.notEqual(first.message.id, second.message.id);
  assert.notEqual(first.message.id, nextCall.message.id);
  assert.deepEqual(
    (await store.getByThread('home', 10, 'owner')).map((row) => row.extra?.liveCompanion?.callId),
    ['call-one', 'call-one', 'call-two'],
  );
  await assert.rejects(persistLiveUserText(store, binding, 'different text', 'client-one'), /identity conflict/);
});

test('canonical spoken segments persist once with real authorship; delegation is never a user message', async () => {
  const messageStore = new MessageStore();
  const identity = createCompanionIdentitySnapshot({
    duty: { catId: 'fable-5', displayName: '宪宪' },
    carrier: { catId: 'codex-astra', displayName: '砚砚' },
    skin: 'black-cat',
    liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
  });
  const binding = {
    userId: 'owner',
    threadId: 'home',
    catId: createCatId('codex-astra'),
    callId: 'call',
    nativeThreadId: 'native',
    realtimeSessionId: 'rtc',
  };
  const envelope = (role = 'user', itemId = 'spoken-1') => ({
    method: 'thread/realtime/item/completed',
    params: {
      threadId: 'native',
      item: { id: itemId, realtimeSessionId: 'rtc', type: 'transcriptSegment', role, text: '合成语音记录' },
    },
  });
  const user = await persistLiveTranscriptItem(messageStore, binding, envelope(), identity);
  assert.equal(user?.catId, null);
  assert.equal(user?.threadId, 'home');
  assert.equal(user?.extra?.liveCompanion?.nativeItemId, 'spoken-1');
  assert.equal(user?.extra?.liveCompanion?.role, 'user');
  assert.deepEqual(user?.extra?.liveCompanion?.identity, identity);
  const replay = await persistLiveTranscriptItem(messageStore, { ...binding, callId: 'reconnect' }, envelope());
  assert.equal(replay, null, 'a replay must not publish the same committed speech again');
  const cat = await persistLiveTranscriptItem(messageStore, binding, envelope('assistant', 'spoken-2'), identity);
  assert.equal(cat?.catId, 'codex-astra');
  assert.equal(cat?.extra?.liveCompanion?.role, 'assistant');
  assert.deepEqual(cat?.extra?.liveCompanion?.identity, identity);
  const wrongIdentity = createCompanionIdentitySnapshot({
    duty: { catId: 'fable-5', displayName: '宪宪' },
    carrier: { catId: 'other-cat', displayName: '别的猫' },
    skin: 'black-cat',
    liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
  });
  await assert.rejects(
    persistLiveTranscriptItem(messageStore, binding, envelope('assistant', 'spoken-3'), wrongIdentity),
    /identity mismatch/,
  );
  const foreign = envelope();
  foreign.params.threadId = 'foreign';
  assert.equal(await persistLiveTranscriptItem(messageStore, binding, foreign), null);
  assert.equal(
    await persistLiveTranscriptItem(messageStore, binding, {
      method: 'thread/realtime/itemAdded',
      params: { threadId: 'native', item: { type: 'handoffRequested', input_transcript: '模型生成的任务摘要' } },
    }),
    null,
  );
  assert.equal(await persistLiveTranscriptItem(messageStore, binding, envelope('system')), null);
});

test('committed native answers remain in the conversation with their real author and source', async () => {
  const store = new MessageStore();
  const identity = createCompanionIdentitySnapshot({
    duty: { catId: 'fable-5', displayName: '宪宪' },
    carrier: { catId: 'codex-astra', displayName: '砚砚' },
    skin: 'black-cat',
    liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
  });
  const binding = {
    userId: 'owner',
    threadId: 'home',
    catId: createCatId('codex-astra'),
    callId: 'call',
    nativeThreadId: 'native',
    realtimeSessionId: 'rtc',
    nativeTurnId: 'turn',
  };
  const answer = {
    method: 'item/completed',
    params: {
      threadId: 'native',
      turnId: 'turn',
      item: {
        type: 'agentMessage',
        id: 'answer-1',
        phase: 'final_answer',
        text: '已回读文档：[原文](docs/source.md)。',
      },
    },
  };
  const stored = await persistLiveTranscriptItem(store, binding, answer, identity);
  assert.equal(stored?.content, answer.params.item.text);
  assert.equal(stored?.catId, 'codex-astra');
  assert.equal(stored?.extra?.liveCompanion?.modality, 'result');
  assert.deepEqual(stored?.extra?.liveCompanion?.identity, identity);
  assert.equal(await persistLiveTranscriptItem(store, { ...binding, callId: 'reconnected' }, answer), null);
  const rows = await store.getByThread('home', 10, 'owner');
  assert.equal(rows.length, 1, 'replay cannot duplicate the full answer');
  assert.equal(
    await persistLiveTranscriptItem(store, binding, { ...answer, params: { ...answer.params, turnId: 'foreign' } }),
    null,
  );
  assert.equal(
    await persistLiveTranscriptItem(store, binding, {
      ...answer,
      params: { ...answer.params, item: { ...answer.params.item, id: 'draft', phase: 'commentary', text: 'draft' } },
    }),
    null,
  );
  assert.equal(await persistLiveTranscriptItem(store, { ...binding, nativeTurnId: undefined }, answer), null);
});
