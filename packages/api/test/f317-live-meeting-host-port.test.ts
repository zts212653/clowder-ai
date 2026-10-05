import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.js';
import type { F317MeetingGrant } from '../src/domains/concierge/meeting/f317-meeting-admission.js';
import { type F317MeetingContext, projectF195Context } from '../src/domains/concierge/meeting/f317-meeting-artifact.js';

test('the owner can attach one exact capture to one talking call without starting a turn per chunk', async () => {
  let onContext!: (item: F317MeetingContext, signal: AbortSignal) => Promise<void>;
  let onFeedError: ((error: Error) => void | Promise<void>) | undefined;
  let onTranscript: (() => void | Promise<void>) | undefined;
  let sourceState: 'ready' | 'unavailable' = 'ready';
  let sourceClosed = false;
  let delayedStream: Promise<{ close(): void }> | undefined;
  const sessions = new LiveCompanionSessions({
    source: {
      bind: (_binding, callbacks) => {
        onContext = callbacks.onContext;
        return {
          epoch: 1,
          cursor: 0,
          refresh: async () => ({ state: sourceState, cursor: 0, delivered: 0 }),
          close: () => {
            sourceClosed = true;
          },
        };
      },
    },
    wakeSource: {
      subscribe: async (_thread, callbacks) => {
        onFeedError = callbacks.onError;
        onTranscript = callbacks.onTranscript;
        return delayedStream ?? { close() {} };
      },
    },
  });
  const catId = createCatId('codex-astra');
  const call = await sessions.prepare({
    binding: { userId: 'owner', threadId: 'home', catId, callId: 'call-1' },
    messageStore: new MessageStore(),
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    householdToolsEnabled: false,
    verifyNativeBinding: async (id) => id === 'native',
    verifyCompanion: async () => true,
    publish() {},
  });
  assert.equal(await sessions.observeCall('owner'), null, 'a prepared call is not a sharing target');
  sessions.claim(call.id, 'owner', 'home', [catId]);
  await call.configure({
    CAT_CAFE_API_URL: 'http://localhost:3012',
    CAT_CAFE_USER_ID: 'owner',
    CAT_CAFE_THREAD_ID: 'home',
    CAT_CAFE_CAT_ID: catId,
    CAT_CAFE_INVOCATION_ID: 'invocation',
    CAT_CAFE_CALLBACK_TOKEN: 'token',
  });
  const writes: string[] = [];
  await call.ready('native', {
    submitText: async () => 'accepted-turn',
    submitContextAtBoundary: async (_text, refs, kind, _signal, authorize) => {
      assert.equal(await authorize(), true);
      assert.equal(kind, 'meeting_context');
      writes.push(refs[0] ?? 'missing');
      return 'native-turn';
    },
    request: async (method) => {
      if (method === 'thread/realtime/start') {
        await call.observe({
          method: 'thread/realtime/started',
          params: { threadId: 'native', realtimeSessionId: 'rtc' },
        });
        await call.observe({ method: 'thread/realtime/sdp', params: { threadId: 'native', sdp: 'answer' } });
      }
      if (method === 'thread/realtime/stop')
        await call.observe({ method: 'thread/realtime/closed', params: { threadId: 'native' } });
      return {};
    },
  });
  try {
    await call.start('offer');
    const observed = await sessions.observeCall('owner');
    assert.deepEqual(observed, {
      userId: 'owner',
      threadId: 'home',
      catId,
      callId: call.id,
      generation: 1,
      state: 'talking',
    });
    assert.equal(await sessions.observeCall('other-owner'), null);
    const controller = new AbortController();
    const grant: F317MeetingGrant = {
      grantId: 'grant-1',
      userId: 'owner',
      liveThreadId: 'home',
      catId,
      callId: call.id,
      generation: 1,
      captureThreadId: 'capture-thread',
      meetingId: 'mtg-1',
      captureStartedAt: 1_790_000_000,
      inputId: 'app-1',
      inputLabel: 'Meeting App',
      signal: controller.signal,
    };
    await assert.rejects(
      sessions.attach({ ...grant, generation: 2 }, async () => true),
      /not_admitted/,
    );
    await sessions.attach(grant, async () => true);
    assert.equal(sessions.isAttached(grant), true);
    assert.equal(sessions.isAttached({ ...grant, grantId: 'foreign-grant' }), false);
    const item = projectF195Context(
      {
        cursor: 1,
        chunkNum: 1,
        revision: 1,
        operation: 'transcript',
        line: { ts: 1_790_000_001, chunk_num: 1, text: '会议内容' },
      },
      {
        threadId: grant.captureThreadId,
        meetingId: grant.meetingId,
        callId: grant.callId,
        generation: grant.generation,
      },
      'transcript-mtg-1.lines.jsonl',
      1,
    );
    await onContext(item, new AbortController().signal);
    await call.onSafeBoundary('idle');
    assert.deepEqual(writes, [], 'a transcript arrival without a user question cannot speak');
    const sent = await call.sendText('请结合本场转写回答', 'client-input');
    assert.equal(sent.delivery, 'accepted');
    await call.observe({
      method: 'thread/realtime/transcript/delta',
      params: { threadId: 'native', role: 'user', delta: '我补充一下' },
    });
    await call.onSafeBoundary('tool_complete');
    assert.deepEqual(writes, [], 'real user speech must defer an outstanding meeting context');
    await call.observe({ method: 'thread/realtime/transcript/done', params: { threadId: 'native', role: 'user' } });
    await call.onSafeBoundary('tool_complete');
    assert.deepEqual(writes, [item.sourceRef]);
    await onFeedError?.(new Error('f195_event_stream_lost'));
    assert.equal(sessions.isAttached(grant), false, 'an open capture cannot preserve a lost Host feed');
    const replacement = { ...grant, grantId: 'grant-2' };
    await sessions.attach(replacement, async () => true);
    assert.equal(sessions.isAttached(grant), false);
    assert.equal(sessions.isAttached(replacement), true);
    await sessions.detach(grant);
    assert.equal(sessions.isAttached(replacement), true, 'old-grant detach cannot remove the replacement');
    sourceState = 'unavailable';
    await onTranscript?.();
    assert.equal(sessions.isAttached(replacement), false, 'artifact/status poll loss closes the attachment');
    sourceState = 'ready';
    assert.equal(sourceClosed, true);
    let releaseStream!: (stream: { close(): void }) => void;
    delayedStream = new Promise((resolve) => {
      releaseStream = resolve;
    });
    const staleAttach = sessions.attach({ ...grant, grantId: 'grant-3' }, async () => true);
    void staleAttach.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    await sessions.close();
    const stopOutcome = await Promise.race([
      staleAttach.then(
        () => 'accepted',
        () => 'rejected',
      ),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 100)),
    ]);
    let lateStreamClosed = false;
    releaseStream({
      close: () => {
        lateStreamClosed = true;
      },
    });
    await assert.rejects(staleAttach, /not_admitted/);
    assert.equal(stopOutcome, 'rejected', 'call stop must settle pending attach before SSE subscribe resolves');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lateStreamClosed, true, 'a stream arriving after stop must be closed');
  } finally {
    await sessions.close();
  }
});
