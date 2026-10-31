import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LiveCompanionCall } from '../src/domains/concierge/live/LiveCompanionCall.js';
import { voiceEnvelope } from './helpers/f317-ns-reg-live.js';

test('a persisted owner correction reaches the active native context even without a realtime handoff', async () => {
  const store = new MessageStore();
  const writes: Array<{ text: string; refs: readonly string[]; kind: string }> = [];
  let wakes = 0;
  const catId = createCatId('codex61-sol');
  const call = await LiveCompanionCall.create({
    binding: { userId: 'owner', threadId: 'home', catId, callId: 'revision-call' },
    householdToolsEnabled: false,
    messageStore: store,
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    verifyNativeBinding: async () => true,
    publish() {},
  });
  await call.configure({
    CAT_CAFE_API_URL: 'http://localhost:3012',
    CAT_CAFE_USER_ID: 'owner',
    CAT_CAFE_THREAD_ID: 'home',
    CAT_CAFE_CAT_ID: catId,
    CAT_CAFE_INVOCATION_ID: 'original',
    CAT_CAFE_CALLBACK_TOKEN: 'test-token',
  });
  await call.ready('native', {
    submitText: async () => 'unused',
    wakeBoundary: () => wakes++,
    submitContextAtBoundary: async (text, refs, kind, signal, authorize) => {
      assert.equal(signal.aborted, false);
      assert.equal(await authorize(), true);
      writes.push({ text, refs, kind });
      return 'active';
    },
    request: async (method) => {
      if (method === 'thread/realtime/start') {
        await call.observe({
          method: 'thread/realtime/started',
          params: { threadId: 'native', realtimeSessionId: 'rtc' },
        });
        await call.observe({ method: 'thread/realtime/sdp', params: { threadId: 'native', sdp: 'answer' } });
      }
      if (method === 'turn/interrupt')
        await call.observe({ method: 'turn/completed', params: { threadId: 'native', turn: { id: 'active' } } });
      return {};
    },
  });
  try {
    await call.start('offer');
    await call.observe({ method: 'turn/started', params: { threadId: 'native', turn: { id: 'active' } } });
    await call.observe(voiceEnvelope('rtc', 'user', 'ipad-revision', '不用Chrome了，改用iPad外放。', 'native'));
    await call.observe(voiceEnvelope('rtc', 'user', 'ipad-revision', '不用Chrome了，改用iPad外放。', 'native'));
    await call.observe(voiceEnvelope('foreign-rtc', 'user', 'foreign-revision', '改回Chrome。', 'native'));
    await call.onSafeBoundary('tool_complete');
    assert.equal(
      writes.length,
      1,
      'the native backend must receive the owner correction, not wait for another handoff',
    );
    assert.equal(writes[0].kind, 'owner_voice_context');
    assert.match(writes[0].text, /不用Chrome了，改用iPad外放/);
    const row = store.getByThread('home', 100, 'owner')[0];
    assert.deepEqual(writes[0].refs, [`home#${row.id}`]);
    assert.ok(wakes > 0);
    await call.observe(voiceEnvelope('rtc', 'user', 'ipad-revision', '不用Chrome了，改用iPad外放。', 'native'));
    await call.onSafeBoundary('tool_complete');
    assert.equal(writes.length, 1, 'native replay does not repeat the update');
    await call.observe(voiceEnvelope('foreign-rtc', 'user', 'foreign-revision', '改回Chrome。', 'native'));
    await call.onSafeBoundary('tool_complete');
    assert.equal(writes.length, 1, 'foreign sessions cannot update the current choice');
  } finally {
    await call.stop();
  }
});
