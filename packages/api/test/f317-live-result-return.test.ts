import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveResultReturn } from '../src/domains/concierge/live/host/live-result-return.js';

function fixture() {
  let connected = true;
  const spoken: string[] = [];
  const fence = new LiveResultReturn({
    client: () => client,
    threadId: () => 'native',
    realtimeSessionId: () => 'rtc',
    available: () => connected,
    verifyCompanion: async () => true,
    handed: () => undefined,
  });
  const client = fence.bind({
    submitText: async () => 'turn',
    request: async (_method, params) => {
      spoken.push(String(params.text));
      return {};
    },
  });
  const observe = (method: string, item: Record<string, unknown>) =>
    fence.observe({ method, params: { threadId: 'native', turnId: 'turn', item } }, 'turn');
  const start = (id: string) => observe('item/started', { id, type: 'agentMessage', phase: 'final_answer' });
  const finish = (id: string, text: string) =>
    fence.present(
      {
        method: 'item/completed',
        params: { threadId: 'native', turnId: 'turn', item: { id, type: 'agentMessage', phase: 'final_answer', text } },
      },
      'turn',
    );
  return {
    fence,
    client,
    spoken,
    observe,
    start,
    finish,
    connection: (value: boolean) => {
      connected = value;
    },
  };
}

test('replayed committed owner speech cannot retire a current result', async () => {
  const f = fixture();
  const segment = { id: 'speech', type: 'transcriptSegment', role: 'user', realtimeSessionId: 'rtc', text: 'hello' };
  f.observe('thread/realtime/item/completed', segment);
  await f.client.submitText('hello', 'source');
  f.observe('item/completed', { type: 'userMessage', clientId: 'source' });
  f.start('answer');
  f.fence.observe(
    { method: 'thread/realtime/transcript/done', params: { role: 'user', realtimeSessionId: 'rtc' } },
    'turn',
  );
  f.observe('thread/realtime/item/completed', segment);
  await f.finish('answer', 'CURRENT_ANSWER');
  assert.deepEqual(f.spoken, ['CURRENT_ANSWER']);
});

test('the original opening completed during connection is returned once after the real transport is ready', async () => {
  const f = fixture();
  f.connection(false);
  f.start('opening');
  await f.finish('opening', 'OPENING');
  assert.deepEqual(f.spoken, []);
  f.connection(true);
  const opening = f.fence.takePendingOpening();
  assert.ok(opening);
  await f.fence.present(opening, 'turn');
  assert.deepEqual(f.spoken, ['OPENING']);
  assert.equal(f.fence.takePendingOpening(), undefined);
});

test('a new owner request retires a connecting opening without changing its history', async () => {
  const f = fixture();
  f.connection(false);
  f.start('opening');
  await f.finish('opening', 'OPENING');
  f.fence.ownerChanged();
  f.connection(true);
  assert.equal(f.fence.takePendingOpening(), undefined);
  assert.deepEqual(f.spoken, []);
});

test('retired source retries never relabel old input as current or exhaust pending qualification capacity', async () => {
  const f = fixture();
  for (let index = 0; index < 300; index++) {
    f.fence.ownerChanged();
    await f.client.submitText('same words', `source-${index}`);
  }
  await f.client.submitText('same words', 'source-0');
  f.observe('item/completed', { type: 'userMessage', clientId: 'source-0' });
  f.start('old');
  await f.finish('old', 'OLD');
  f.observe('item/completed', { type: 'userMessage', clientId: 'source-299' });
  f.start('current');
  await f.finish('current', 'CURRENT');
  assert.deepEqual(f.spoken, ['CURRENT']);
});

test('completed tool commentary cannot crowd out the actual final result', async () => {
  const f = fixture();
  for (let index = 0; index < 70; index++) {
    const item = { id: `commentary-${index}`, type: 'agentMessage', phase: 'commentary', text: 'working' };
    f.observe('item/started', item);
    f.observe('item/completed', item);
    await f.fence.present({ method: 'item/completed', params: { threadId: 'native', turnId: 'turn', item } }, 'turn');
  }
  f.start('final');
  await f.finish('final', 'ACTUAL_RESULT');
  assert.deepEqual(f.spoken, ['ACTUAL_RESULT']);
});

test('the complete sourced result stays available for history while the voice return uses its opening conclusion', async () => {
  const f = fixture();
  f.fence.ownerChanged();
  await f.client.submitText('Compare the reports', 'source');
  f.observe('item/completed', { type: 'userMessage', clientId: 'source' });
  f.start('answer');
  const body = '这份报告不是你问的 SOP。\n\n证据：第一份文件的版本与主题不同。\n\n原引用与完整分析在这里。';
  await f.finish('answer', body);
  assert.deepEqual(f.spoken, ['这份报告不是你问的 SOP。']);
  assert.ok(body.includes('完整分析'), 'voice selection never rewrites the original persisted body');
});

test('a distinct committed speech segment retires an answer without requiring transcript delta or done', async () => {
  const f = fixture();
  f.observe('thread/realtime/item/completed', {
    id: 'first-speech',
    type: 'transcriptSegment',
    role: 'user',
    realtimeSessionId: 'rtc',
    text: 'first request',
  });
  await f.client.submitText('first request', 'first-source');
  f.observe('item/completed', { type: 'userMessage', clientId: 'first-source' });
  f.start('first-answer');
  f.observe('thread/realtime/item/completed', {
    id: 'second-speech',
    type: 'transcriptSegment',
    role: 'user',
    realtimeSessionId: 'rtc',
    text: 'change the request',
  });
  await f.finish('first-answer', 'STALE_FIRST_ANSWER');
  assert.deepEqual(f.spoken, []);
});
