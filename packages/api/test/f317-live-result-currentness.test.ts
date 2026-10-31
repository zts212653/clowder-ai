import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LiveCompanionCall } from '../src/domains/concierge/live/LiveCompanionCall.js';

async function fixture() {
  const store = new MessageStore();
  const writes: Array<{ method: string; params: Record<string, unknown> }> = [];
  const contexts: Array<{ id?: string; refs: readonly string[] }> = [];
  const published: string[] = [];
  const call = await LiveCompanionCall.create({
    binding: { userId: 'owner', threadId: 'home', callId: 'synthetic-call', catId: createCatId('codex61-sol') },
    messageStore: store,
    householdToolsEnabled: false,
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    verifyNativeBinding: async () => true,
    publish: (message) => published.push(message.id),
  });
  const observe = (method: string, params: Record<string, unknown>) =>
    call.observe({ method, params: { threadId: 'native', ...params } });
  await call.configure({
    CAT_CAFE_API_URL: 'http://127.0.0.1:3012',
    CAT_CAFE_USER_ID: 'owner',
    CAT_CAFE_THREAD_ID: 'home',
    CAT_CAFE_CAT_ID: 'codex61-sol',
    CAT_CAFE_INVOCATION_ID: 'synthetic-invocation',
    CAT_CAFE_CALLBACK_TOKEN: 'synthetic',
  });
  await observe('turn/started', { turn: { id: 'turn' } });
  await call.ready('native', {
    submitText: async () => 'turn',
    submitContextAtBoundary: async (_text, refs, _kind, _signal, authorize, id?: string) => {
      assert.equal(await authorize(), true);
      contexts.push({ refs, id });
      return 'turn';
    },
    request: async (method, params) => {
      writes.push({ method, params });
      if (method === 'thread/realtime/start') {
        await observe('thread/realtime/started', { realtimeSessionId: 'rtc' });
        await observe('thread/realtime/sdp', { sdp: 'synthetic-answer' });
      }
      if (method === 'thread/realtime/stop') await observe('thread/realtime/closed', {});
      if (method === 'turn/interrupt') await observe('turn/completed', { turn: { id: 'turn' } });
      return {};
    },
  });
  await call.start('synthetic-offer');
  return {
    call,
    store,
    writes,
    contexts,
    published,
    observe,
    async speech(id: string, text: string) {
      await observe('thread/realtime/transcript/delta', { role: 'user', delta: text });
      await observe('thread/realtime/item/completed', {
        item: { id, realtimeSessionId: 'rtc', type: 'transcriptSegment', role: 'user', text },
      });
      await observe('thread/realtime/transcript/done', { role: 'user', text });
      await call.onSafeBoundary('idle');
      return contexts.at(-1);
    },
    async consumed(id: string | undefined, turnId = 'turn') {
      await observe('item/completed', {
        turnId,
        item: { id: `input-${contexts.length}`, type: 'userMessage', clientId: id },
      });
    },
    async startOutput(id: string, turnId = 'turn') {
      await observe('item/started', { turnId, item: { id, type: 'agentMessage', phase: 'final_answer', text: '' } });
    },
    async finishOutput(id: string, text: string, turnId = 'turn') {
      await observe('item/completed', { turnId, item: { id, type: 'agentMessage', phase: 'final_answer', text } });
    },
    audio() {
      return writes.filter((w) => w.method === 'thread/realtime/appendSpeech').map((w) => w.params.text);
    },
  };
}

test('native automatic output is disabled before the voice transport starts', async () => {
  const f = await fixture();
  try {
    assert.equal(f.writes[0].params.clientManagedHandoffs, true);
  } finally {
    await f.call.stop();
  }
});

test('new request acceptance cannot qualify the old greeting; committed current input can qualify the result', async () => {
  const f = await fixture();
  try {
    const hello = await f.speech('hello', 'hello');
    assert.ok(hello?.id, 'source-linked native client id is required');
    await f.consumed(hello.id);
    await f.startOutput('old');
    const task = await f.speech('task', 'check synthetic work');
    assert.ok(task?.id);
    await f.finishOutput('old', 'OLD_HELLO');
    assert.deepEqual(f.audio(), []);
    assert.ok(
      f.store.getByThread('home', 20).some((m) => m.content === 'OLD_HELLO'),
      'retain the actual native history',
    );
    await f.consumed(task.id);
    await f.startOutput('current');
    await f.finishOutput('current', 'CURRENT_TASK_RECEIPT');
    assert.deepEqual(f.audio(), ['CURRENT_TASK_RECEIPT']);
    await f.finishOutput('current', 'CURRENT_TASK_RECEIPT');
    assert.deepEqual(f.audio(), ['CURRENT_TASK_RECEIPT'], 'duplicate native completion cannot replay speech');
  } finally {
    await f.call.stop();
  }
});

test('a later explicit greeting is a new source even with identical text', async () => {
  const f = await fixture();
  try {
    const first = await f.speech('first', 'hello');
    const second = await f.speech('second', 'hello');
    assert.ok(first?.id && second?.id);
    assert.notEqual(first.id, second.id);
    await f.consumed(first.id);
    await f.startOutput('late');
    await f.finishOutput('late', 'OLD_HELLO');
    await f.consumed(second.id);
    await f.startOutput('new-greeting');
    await f.finishOutput('new-greeting', 'NEW_HELLO');
    assert.deepEqual(f.audio(), ['NEW_HELLO']);
  } finally {
    await f.call.stop();
  }
});

test('speech beginning while an answer is forming removes its presentation eligibility without cancelling work', async () => {
  const f = await fixture();
  try {
    const source = await f.speech('initial', 'check work');
    assert.ok(source?.id);
    await f.consumed(source.id);
    await f.startOutput('pending-answer');
    await f.observe('thread/realtime/transcript/delta', { role: 'user', delta: 'add a condition' });
    await f.finishOutput('pending-answer', 'PREVIOUS_PLAN');
    assert.deepEqual(f.audio(), []);
    assert.equal(
      f.writes.some((w) => w.method === 'turn/interrupt'),
      false,
    );
  } finally {
    await f.call.stop();
  }
});

test('a new call opening and ordinary fast voice survive; foreign source consumption cannot qualify work', async () => {
  const f = await fixture();
  try {
    await f.startOutput('opening');
    await f.finishOutput('opening', 'OPENING');
    await f.observe('thread/realtime/item/completed', {
      item: { id: 'fast', type: 'transcriptSegment', realtimeSessionId: 'rtc', role: 'assistant', text: 'FAST_ACK' },
    });
    const source = await f.speech('task', 'check work');
    assert.ok(source?.id);
    await f.consumed(source.id, 'foreign-turn');
    await f.startOutput('unqualified');
    await f.finishOutput('unqualified', 'UNQUALIFIED');
    assert.deepEqual(f.audio(), ['OPENING']);
    assert.ok(f.store.getByThread('home', 20).some((m) => m.content === 'FAST_ACK'));
  } finally {
    await f.call.stop();
  }
});
