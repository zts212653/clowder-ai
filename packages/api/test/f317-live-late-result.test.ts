import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveResultReturn } from '../src/domains/concierge/live/host/live-result-return.js';

function fixture() {
  const spoken: string[] = [];
  const deferred: Array<{ turnId: string; itemId: string; sourceRefs: readonly string[] }> = [];
  const deps = {
    client: () => native,
    threadId: () => 'native',
    realtimeSessionId: () => 'rtc',
    available: () => true,
    verifyCompanion: async () => true,
    handed() {},
    defer: (turnId: string, itemId: string, sourceRefs: readonly string[]) => {
      deferred.push({ turnId, itemId, sourceRefs });
    },
  };
  const r = new LiveResultReturn(deps);
  const native = {
    submitText: async () => 'turn',
    submitContextAtBoundary: async (
      _text: string,
      _refs: readonly string[],
      _kind: string,
      _signal: AbortSignal,
      _authorize: () => Promise<boolean>,
      id?: string,
    ) => {
      return id ?? 'turn';
    },
    request: async (_method: string, params: Record<string, unknown>) => {
      spoken.push(String(params.text));
      return {};
    },
  };
  const client = r.bind(native);
  const event = (method: string, item: Record<string, unknown>) => ({
    method,
    params: { threadId: 'native', turnId: 'turn', item },
  });
  return { r, client, spoken, deferred, event };
}

test('a topic change defers the original sourced result once without speaking its old body', async () => {
  const f = fixture();
  f.r.ownerChanged();
  await f.client.submitText('Compare the old SOP and new report', 'owner-source');
  f.r.observe(f.event('item/completed', { type: 'userMessage', clientId: 'owner-source' }), 'turn');
  f.r.observe(f.event('item/started', { type: 'agentMessage', phase: 'final_answer', id: 'old-result' }), 'turn');
  f.r.ownerChanged();
  const result = f.event('item/completed', {
    type: 'agentMessage',
    phase: 'final_answer',
    id: 'old-result',
    text: 'OLD BODY',
  });
  await f.r.present(result, 'turn');
  await f.r.present(result, 'turn');
  assert.deepEqual(f.spoken, []);
  assert.deepEqual(f.deferred, [{ turnId: 'turn', itemId: 'old-result', sourceRefs: ['owner-source'] }]);
  f.r.close();
});

test('a current source-referenced late reminder can speak; a further correction retires it without creating another late reminder', async () => {
  const f = fixture();
  f.r.ownerChanged();
  const id = await f.client.submitContextAtBoundary?.(
    'Read the saved result and current corrections; remind only if relevant',
    ['home#original', 'home#saved-result'],
    'late_result_notice',
    new AbortController().signal,
    async () => true,
  );
  f.r.observe(f.event('item/completed', { type: 'userMessage', clientId: id }), 'turn');
  f.r.observe(f.event('item/started', { type: 'agentMessage', phase: 'final_answer', id: 'reminder' }), 'turn');
  await f.r.present(
    f.event('item/completed', {
      type: 'agentMessage',
      phase: 'final_answer',
      id: 'reminder',
      text: 'The earlier comparison is saved; it concerns a different SOP.',
    }),
    'turn',
  );
  assert.equal(f.spoken.length, 1);
  const id2 = await f.client.submitContextAtBoundary?.(
    'Another saved result',
    ['home#another-result'],
    'late_result_notice',
    new AbortController().signal,
    async () => true,
  );
  f.r.observe(f.event('item/completed', { type: 'userMessage', clientId: id2 }), 'turn');
  f.r.observe(f.event('item/started', { type: 'agentMessage', phase: 'final_answer', id: 'retired-reminder' }), 'turn');
  f.r.ownerChanged();
  await f.r.present(
    f.event('item/completed', {
      type: 'agentMessage',
      phase: 'final_answer',
      id: 'retired-reminder',
      text: 'SUPERSEDED BODY',
    }),
    'turn',
  );
  assert.equal(f.spoken.length, 1);
  assert.equal(f.deferred.length, 0);
  f.r.close();
});

test('an unqualified page result cannot borrow the preceding owner request when topics change', async () => {
  const f = fixture();
  f.r.ownerChanged();
  await f.client.submitText('Owner question A', 'source-A');
  f.r.observe(f.event('item/completed', { type: 'userMessage', clientId: 'source-A' }), 'turn');
  const pageId = await f.client.submitContextAtBoundary?.(
    'Read the page result',
    ['page-result'],
    'page_action_result',
    new AbortController().signal,
    async () => true,
  );
  f.r.ownerChanged();
  f.r.observe(f.event('item/completed', { type: 'userMessage', clientId: pageId }), 'turn');
  f.r.observe(f.event('item/started', { type: 'agentMessage', phase: 'final_answer', id: 'page-answer' }), 'turn');
  const answer = f.event('item/completed', {
    type: 'agentMessage',
    phase: 'final_answer',
    id: 'page-answer',
    text: 'The previous page result',
  });
  assert.equal(f.r.projection(answer, 'turn'), undefined, 'page context is not an original human request');
  await f.r.present(answer, 'turn');
  assert.deepEqual(f.deferred, []);
  assert.deepEqual(f.spoken, [], 'a later topic does not receive the old page answer');
  f.r.close();
});

for (const replay of ['adjacent', 'out-of-order'] as const) {
  test(`${replay} consumed-input replay cannot change the latest owner qualification`, async () => {
    const f = fixture();
    f.r.ownerChanged();
    await f.client.submitText('Owner question A', 'source-A');
    f.r.observe(f.event('item/completed', { type: 'userMessage', clientId: 'source-A' }), 'turn');
    if (replay === 'out-of-order') {
      f.r.ownerChanged();
      await f.client.submitText('Owner question B', 'source-B');
      f.r.observe(f.event('item/completed', { type: 'userMessage', clientId: 'source-B' }), 'turn');
    }
    f.r.observe(f.event('item/completed', { type: 'userMessage', clientId: 'source-A' }), 'turn');
    f.r.observe(f.event('item/started', { type: 'agentMessage', phase: 'final_answer', id: 'current' }), 'turn');
    const answer = f.event('item/completed', {
      type: 'agentMessage',
      phase: 'final_answer',
      id: 'current',
      text: 'Current answer',
    });
    assert.deepEqual(f.r.projection(answer, 'turn'), {
      presentationEligibility: 'current',
      requestRefs: [replay === 'out-of-order' ? 'source-B' : 'source-A'],
    });
    await f.r.present(answer, 'turn');
    assert.deepEqual(f.spoken, ['Current answer']);
    assert.deepEqual(f.deferred, []);
    f.r.close();
  });
}

test('unknown provider input clears owner attribution instead of inheriting the latest request', async () => {
  const f = fixture();
  f.r.ownerChanged();
  await f.client.submitText('Owner question A', 'source-A');
  f.r.observe(f.event('item/completed', { type: 'userMessage', clientId: 'source-A' }), 'turn');
  f.r.observe(f.event('item/completed', { type: 'userMessage', clientId: 'unknown' }), 'turn');
  f.r.observe(f.event('item/started', { type: 'agentMessage', phase: 'final_answer', id: 'unknown-answer' }), 'turn');
  assert.equal(f.r.projection(f.event('item/completed', { id: 'unknown-answer' }), 'turn'), undefined);
  f.r.close();
});

test('an aborted reminder cannot publish a result projection or submit speech', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.r.ownerChanged();
  const id = await f.client.submitContextAtBoundary?.(
    'Read the current saved result',
    ['home#saved-result'],
    'late_result_notice',
    controller.signal,
    async () => true,
  );
  f.r.observe(f.event('item/completed', { type: 'userMessage', clientId: id }), 'turn');
  f.r.observe(f.event('item/started', { type: 'agentMessage', phase: 'final_answer', id: 'aborted-answer' }), 'turn');
  controller.abort();
  const answer = f.event('item/completed', {
    type: 'agentMessage',
    phase: 'final_answer',
    id: 'aborted-answer',
    text: 'Aborted answer',
  });
  assert.equal(f.r.projection(answer, 'turn'), undefined);
  await f.r.present(answer, 'turn');
  assert.deepEqual(f.spoken, []);
  assert.deepEqual(f.deferred, []);
  f.r.close();
});
