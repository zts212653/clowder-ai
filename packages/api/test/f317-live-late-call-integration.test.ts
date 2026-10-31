import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LiveCompanionCall } from '../src/domains/concierge/live/LiveCompanionCall.js';
import { adaptMessageStore } from './helpers/message-from-fixtures.js';

async function fixture(store: MessageStore, suffix: string) {
  const root = `root-${suffix}`;
  const turn = `turn-${suffix}`;
  const spoken: string[] = [];
  const notices: Array<{ refs: readonly string[]; text: string; id?: string }> = [];
  const call = await LiveCompanionCall.create({
    binding: { userId: 'owner', threadId: 'home', catId: createCatId('codex61-sol'), callId: `call-${suffix}` },
    messageStore: store,
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    verifyNativeBinding: async () => true,
    verifyCompanion: async () => true,
    publish() {},
  });
  const event = (method: string, item: object) => ({ method, params: { threadId: root, turnId: turn, item } });
  await call.ready(root, {
    submitText: async () => turn,
    submitContextAtBoundary: async (text, refs, kind, _signal, authorize, id) => {
      assert.equal(await authorize(), true);
      if (kind === 'late_result_notice') notices.push({ refs, text, id });
      return turn;
    },
    request: async (method, params) => {
      if (method === 'thread/realtime/start') {
        await call.observe({
          method: 'thread/realtime/started',
          params: { threadId: root, realtimeSessionId: `rtc-${suffix}` },
        });
        await call.observe({ method: 'thread/realtime/sdp', params: { threadId: root, sdp: 'answer' } });
      }
      if (method === 'thread/realtime/appendSpeech') spoken.push(String(params.text));
      if (method === 'thread/realtime/stop')
        await call.observe({ method: 'thread/realtime/closed', params: { threadId: root } });
      if (method === 'turn/interrupt')
        await call.observe({ method: 'turn/completed', params: { threadId: root, turn: { id: turn } } });
      return {};
    },
  });
  await call.observe({ method: 'turn/started', params: { threadId: root, turn: { id: turn } } });
  await call.start('synthetic-offer');
  return { call, spoken, notices, event };
}

test('actual Call wiring retains a corrected old result, recovers it on reentry, and speaks only a current natural reminder once', async () => {
  const store = adaptMessageStore(new MessageStore());
  const first = await fixture(store, 'one');
  const original = await first.call.sendText('Compare the old SOP and the new report', 'original');
  await first.call.observe(first.event('item/completed', { type: 'userMessage', clientId: original.messageId }));
  await first.call.observe(
    first.event('item/started', { type: 'agentMessage', phase: 'final_answer', id: 'old-result' }),
  );
  await first.call.sendText('Correction: this is a different SOP; now switch topics', 'correction');
  await first.call.observe(
    first.event('item/completed', {
      type: 'agentMessage',
      phase: 'final_answer',
      id: 'old-result',
      text: 'ORIGINAL_EVIDENCE_BODY',
    }),
  );
  assert.deepEqual(first.spoken, []);
  const result = (await store.getByThread('home')).find((row) => row.content === 'ORIGINAL_EVIDENCE_BODY');
  assert.equal(
    result?.extra?.liveCompanion?.modality === 'result' &&
      result.extra.liveCompanion.returnProjection?.presentationEligibility,
    'deferred',
  );
  await first.call.stop();
  const second = await fixture(store, 'two');
  try {
    await second.call.onSafeBoundary('idle');
    await second.call.onSafeBoundary('idle');
    assert.equal(second.notices.length, 1);
    assert.ok(second.notices[0].refs.includes(`thread:home#${result?.id}`));
    assert.ok(
      !second.notices[0].text.includes('ORIGINAL_EVIDENCE_BODY'),
      'the native reminder reads canonical references, not a replayed body',
    );
    await second.call.observe(second.event('item/completed', { type: 'userMessage', clientId: second.notices[0].id }));
    await second.call.observe(
      second.event('item/started', { type: 'agentMessage', phase: 'final_answer', id: 'notice' }),
    );
    await second.call.observe(
      second.event('item/completed', {
        type: 'agentMessage',
        phase: 'final_answer',
        id: 'notice',
        text: '先前报告与所问 SOP 不同；原结果已保存在正文。',
      }),
    );
    assert.deepEqual(second.spoken, ['先前报告与所问 SOP 不同；原结果已保存在正文。']);
    await second.call.onSafeBoundary('idle');
    assert.equal(second.notices.length, 1, 'a committed reminder cannot reexecute or create repeated notices');
  } finally {
    await second.call.stop();
  }
  const third = await fixture(store, 'three');
  try {
    await third.call.onSafeBoundary('idle');
    assert.equal(third.notices.length, 0, 'a persisted reminder remains resolved after another reentry');
  } finally {
    await third.call.stop();
  }
});
