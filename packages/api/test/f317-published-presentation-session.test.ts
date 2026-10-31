import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.js';

test('the production Session and Call preserve the Host guard and claimed owner on a synthetic native session', async () => {
  const sessions = new LiveCompanionSessions();
  const store = new MessageStore();
  const catId = createCatId('codex61-sol');
  const callId = randomUUID();
  const call = await sessions.prepare({
    binding: { userId: 'owner', threadId: 'home', catId, callId },
    messageStore: store,
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    verifyNativeBinding: async () => true,
    verifyCompanion: async () => true,
    householdToolsEnabled: false,
    publish() {},
  });
  try {
    assert.deepEqual(
      await sessions.observePresentation(
        'owner',
        {
          kind: 'presentation.observe',
          event: 'first_text_visible',
          observedAt: Date.now(),
          callId,
          reference: { kind: 'message', messageId: 'not-yet-published' },
        },
        async () => true,
      ),
      { kind: 'error', code: 'invalid_request' },
    );
    await sessions.claim(callId, 'owner', 'home', [catId]);
    await call.ready('root', {
      submitText: async () => 'turn',
      request: async (method) => {
        if (method === 'thread/realtime/start') {
          await call.observe({
            method: 'thread/realtime/started',
            params: { threadId: 'root', realtimeSessionId: 'rtc' },
          });
          await call.observe({ method: 'thread/realtime/sdp', params: { threadId: 'root', sdp: 'synthetic-answer' } });
        }
        if (method === 'thread/realtime/stop')
          await call.observe({ method: 'thread/realtime/closed', params: { threadId: 'root' } });
        return {};
      },
    });
    await call.start('synthetic-offer');
    const message = store.append({
      userId: 'owner',
      threadId: 'home',
      from: { kind: 'agent', catId },
      content: 'Synthetic visible answer',
      mentions: [],
      timestamp: Date.now(),
      extra: {
        liveCompanion: {
          modality: 'voice',
          callId,
          nativeThreadId: 'root',
          realtimeSessionId: 'rtc',
          nativeItemId: 'item',
        },
      },
    });
    const receipt = {
      kind: 'presentation.observe' as const,
      event: 'first_text_visible' as const,
      observedAt: Date.now(),
      callId,
      reference: { kind: 'message' as const, messageId: message.id },
    };
    assert.deepEqual(await sessions.observePresentation('foreign', receipt, async () => true), {
      kind: 'error',
      code: 'invalid_request',
    });
    assert.deepEqual(
      await sessions.observePresentation('owner', receipt, async () => false),
      { kind: 'error', code: 'invalid_request' },
      'the full production delegation must preserve the Host generation guard',
    );
    assert.deepEqual(await sessions.observePresentation('owner', receipt, async () => true), { kind: 'ok' });
  } finally {
    await sessions.close();
  }
});
