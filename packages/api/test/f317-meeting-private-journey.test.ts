import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.js';
import type { F195CaptureObservation } from '../src/domains/concierge/meeting/f317-meeting-admission.js';
import { F317MeetingShareService } from '../src/domains/concierge/meeting/f317-meeting-share-service.js';
import { createF317MeetingSource } from '../src/domains/concierge/meeting/f317-meeting-source.js';

test('durable F195 transcript reaches only the explicitly shared private Live user turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f317-private-journey-'));
  const capture: F195CaptureObservation = {
    running: true,
    paused: false,
    threadId: 'thread-1',
    meetingId: 'mtg-1',
    startedAt: 1_790_000_000,
    inputs: [{ id: 'meeting-app', source: 'app', label: 'Synthetic Meeting App', state: 'running' }],
  };
  const producer = [
    'import sys',
    'sys.path.insert(0, "scripts/meeting-copilot")',
    'from transcript_store import TranscriptArtifactStore',
    'store = TranscriptArtifactStore(sys.argv[1], "thread-1", "mtg-1", "Synthetic Meeting App", [])',
    'store.append_line({"ts": 1790000001, "elapsed_s": 1, "chunk_num": 1, "text": "雪松计划截止十月三日，预算七百二十元。", "speaker_label": "Lin", "speaker_confidence": 0.94, "speaker_identity_source": "session_cluster", "input_id": "meeting-app", "input_source": "app", "input_label": "Synthetic Meeting App"})',
  ].join('\n');
  execFileSync('python3', ['-c', producer, root], { cwd: join(import.meta.dirname, '../../..') });

  let onTranscript: (() => void | Promise<void>) | undefined;
  const source = createF317MeetingSource({
    transcriptDir: root,
    audioServiceUrl: 'http://audio.test',
    fetchFn: async () =>
      new Response(
        JSON.stringify({ running: capture.running, meeting_id: capture.meetingId, thread_id: capture.threadId }),
      ),
  });
  const sessions = new LiveCompanionSessions({
    source,
    wakeSource: {
      subscribe: async (_threadId, callbacks) => {
        onTranscript = callbacks.onTranscript;
        return { close() {} };
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
  const service = new F317MeetingShareService({
    observeCall: (userId) => sessions.observeCall(userId),
    observeCapture: async () => capture,
    ownerOfThread: async (threadId) => (threadId === 'thread-1' ? 'owner' : null),
    attach: (grant, verify) => sessions.attach(grant, verify),
    detach: (grant) => sessions.detach(grant),
    isAttached: (grant) => sessions.isAttached(grant),
  });
  sessions.claim(call.id, 'owner', 'home', [catId]);
  await call.configure({
    CAT_CAFE_API_URL: 'http://localhost:3012',
    CAT_CAFE_USER_ID: 'owner',
    CAT_CAFE_THREAD_ID: 'home',
    CAT_CAFE_CAT_ID: catId,
    CAT_CAFE_INVOCATION_ID: 'invocation',
    CAT_CAFE_CALLBACK_TOKEN: 'token',
  });
  const privateWrites: Array<{ text: string; refs: readonly string[] }> = [];
  await call.ready('native', {
    submitText: async () => 'accepted-turn',
    submitContextAtBoundary: async (text, refs, kind, _signal, authorize) => {
      assert.equal(kind, 'meeting_context');
      assert.equal(await authorize(), true);
      privateWrites.push({ text, refs });
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
    const preview = await service.preview('owner');
    assert.equal(preview.kind, 'available');
    if (preview.kind !== 'available') return;
    assert.equal(preview.sharing, false);
    assert.deepEqual(privateWrites, [], 'durable transcript alone must not enter Live');
    const grant = await service.share('owner', preview.intent);
    assert.equal(sessions.isAttached(grant), true);
    assert.equal((await service.preview('owner')).kind, 'available');
    await call.onSafeBoundary('idle');
    assert.deepEqual(privateWrites, [], 'attaching and artifact replay must not start a provider turn');

    const sent = await call.sendText('合成会议的截止日期和预算是什么？', 'client-input');
    assert.equal(sent.delivery, 'accepted');
    await call.observe({ method: 'thread/realtime/transcript/done', params: { threadId: 'native', role: 'user' } });
    await call.onSafeBoundary('tool_complete');
    assert.equal(privateWrites.length, 1);
    assert.deepEqual(privateWrites[0].refs, ['f195-transcript:thread-1:mtg-1:transcript-mtg-1.lines.jsonl:1:1']);
    assert.match(privateWrites[0].text, /十月三日/);
    assert.match(privateWrites[0].text, /七百二十元/);
    const envelope = JSON.parse(privateWrites[0].text.split('\n').slice(1).join('\n')) as {
      kind: string;
      text: string;
    };
    const payload = JSON.parse(envelope.text) as {
      items: Array<{ context: { provenance: string; content: string } }>;
    };
    assert.equal(envelope.kind, 'meeting_context');
    assert.equal(payload.items[0]?.context.provenance, 'transcript');
    assert.match(payload.items[0]?.context.content ?? '', /十月三日.*七百二十元/);

    await onTranscript?.();
    await onTranscript?.();
    await call.observe({ method: 'thread/realtime/transcript/done', params: { threadId: 'native', role: 'user' } });
    await call.onSafeBoundary('tool_complete');
    assert.equal(privateWrites.length, 1, 'duplicate wake and an empty later turn cannot resend accepted context');

    await service.revoke('owner');
    assert.equal(grant.signal.aborted, true);
    assert.equal(sessions.isAttached(grant), false);
    const meta = JSON.parse(await readFile(join(root, 'thread-1', 'meta.json'), 'utf8')) as {
      structured_transcript_path: string;
    };
    await appendFile(
      meta.structured_transcript_path,
      `${JSON.stringify({
        v: 1,
        kind: 'transcript',
        cursor: 2,
        meeting_id: 'mtg-1',
        thread_id: 'thread-1',
        chunk_num: 2,
        revision: 1,
        line: { ts: 1_790_000_002, text: '撤销后的迟到内容', chunk_num: 2 },
      })}\n`,
    );
    await onTranscript?.();
    await call.observe({ method: 'thread/realtime/transcript/done', params: { threadId: 'native', role: 'user' } });
    await call.onSafeBoundary('tool_complete');
    assert.equal(privateWrites.length, 1, 'late source data cannot enter a revoked Live call');
  } finally {
    await sessions.close();
    await rm(root, { recursive: true, force: true });
  }
});
