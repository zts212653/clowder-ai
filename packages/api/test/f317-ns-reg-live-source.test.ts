// F317 north-star regression harness, Tier A: invariants the subtitle/typing source contract
// must not break. They hold on the delivered Host today and must still hold on any candidate.
// No media, no visible cat. Counterexample names follow
// docs/plans/2026-09-30-f317-desktop-northstar-implementation.md#验证与交付.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { CodexAppServerRpcError } from '../src/domains/cats/services/agents/providers/codex-app-server-rpc-error.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { persistLiveTranscriptItem } from '../src/domains/concierge/live/live-transcript.js';
import {
  identity,
  liveHarness,
  liveOf,
  NATIVE_THREAD,
  OWNER,
  resultEnvelope,
  THREAD,
  voiceEnvelope,
} from './helpers/f317-ns-reg-live.js';

// ---------------------------------------------------------------- 旧 call 迟到

test('a late item from another realtime session never becomes part of the current call', async () => {
  const h = await liveHarness({ callId: 'A', realtimeSessionId: 'rtc-A' });
  try {
    await h.voice('user', 'u1', '当前通话');
    await h.foreignVoice('rtc-OLD', 'user', 'old-1', '旧会话迟到的话');
    await h.foreignVoice('rtc-OLD', 'assistant', 'old-2', '旧会话迟到的回答');
    const rows = h.rows();
    assert.deepEqual(
      rows.map((row) => row.content),
      ['当前通话'],
    );
    assert.equal(h.published.length, 1, 'a late foreign item is neither stored nor published');
  } finally {
    await h.call.stop();
  }
});

test('after stop, a late provider item is dropped without an error and without a row', async () => {
  const h = await liveHarness({ callId: 'A' });
  await h.voice('user', 'u1', '停止前');
  await h.call.stop();
  const before = h.rows().length;
  await h.voice('assistant', 'late-1', '停止后迟到的话');
  await h.voice('user', 'late-2', '停止后迟到的用户话');
  assert.equal(h.rows().length, before);
  assert.equal(h.published.length, 1);
});

test('a second call in the same thread keeps its own rows; call A late items cannot reach call B', async () => {
  const a = await liveHarness({ callId: 'A', realtimeSessionId: 'rtc-A' });
  await a.voice('user', 'a-1', 'A 通话里的话');
  await a.call.stop();
  const b = await liveHarness({ callId: 'B', realtimeSessionId: 'rtc-B', store: a.store });
  try {
    await b.voice('user', 'b-1', 'B 通话里的话');
    // A's provider replays a committed item into B's observer, and A's own observer gets a late one.
    await b.foreignVoice('rtc-A', 'user', 'a-late', 'A 的迟到片段');
    await a.voice('user', 'a-late', 'A 的迟到片段');
    const byCall = new Map<string, string[]>();
    for (const row of b.rows()) {
      const callId = liveOf(row)?.callId ?? 'none';
      byCall.set(callId, [...(byCall.get(callId) ?? []), row.content]);
    }
    assert.deepEqual(Object.fromEntries(byCall), { A: ['A 通话里的话'], B: ['B 通话里的话'] });
    assert.equal(b.published.length, 1, 'only B’s own segment was published on B');
  } finally {
    await b.call.stop();
  }
});

test('a stopped call accepts no typed text and leaves no orphan row or native submission', async () => {
  const h = await liveHarness({ callId: 'A' });
  await h.call.stop();
  await assert.rejects(h.call.sendText('停止后打字', 'client-late'), /unavailable/);
  assert.equal(h.rows().length, 0);
  assert.equal(h.submitted.length, 0);
});

// ---------------------------------------------------------------- 同文不同 ID

test('identical spoken text with different provider item ids stays two rows, each keeping its own source id', async () => {
  const h = await liveHarness();
  try {
    await h.voice('user', 'u1', '好的');
    await h.voice('user', 'u2', '好的');
    const rows = h.rows();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => liveOf(row)?.nativeItemId).sort(), ['u1', 'u2']);
    assert.equal(new Set(rows.map((row) => row.id)).size, 2);
  } finally {
    await h.call.stop();
  }
});

test('identical typed text with different client ids is two messages and two native submissions', async () => {
  const h = await liveHarness();
  try {
    const first = await h.call.sendText('同一句话', 'client-1');
    const second = await h.call.sendText('同一句话', 'client-2');
    assert.notEqual(first.messageId, second.messageId);
    assert.equal(h.submitted.length, 2);
    assert.notEqual(h.submitted[0]?.source, h.submitted[1]?.source);
    assert.equal(h.rows().filter((row) => row.content === '同一句话').length, 2);
  } finally {
    await h.call.stop();
  }
});

test('the same client id is one message and one submission however often it is replayed', async () => {
  const h = await liveHarness();
  try {
    const first = await h.call.sendText('只发一次', 'client-1');
    const again = await Promise.all([h.call.sendText('只发一次', 'client-1'), h.call.sendText('只发一次', 'client-1')]);
    for (const value of again) assert.equal(value.messageId, first.messageId);
    assert.equal(h.submitted.length, 1);
    assert.equal(h.rows().length, 1);
    assert.equal(h.published.length, 1);
  } finally {
    await h.call.stop();
  }
});

test('typed and spoken text that happen to match are both kept and are not confused for one another', async () => {
  const h = await liveHarness();
  try {
    await h.voice('user', 'u1', '你好');
    await h.call.sendText('你好', 'client-1');
    const rows = h.rows().filter((row) => row.content === '你好');
    assert.equal(rows.length, 2, 'no cross-modality text dedupe');
    const spoken = rows.filter((row) => liveOf(row)?.modality === 'voice');
    assert.equal(spoken.length, 1, 'exactly one of the two is the spoken segment');
    assert.equal(liveOf(spoken[0]!)?.nativeItemId, 'u1');
  } finally {
    await h.call.stop();
  }
});

// ---------------------------------------------------------------- 保存重放

test('a replayed spoken segment is neither stored nor published twice', async () => {
  const h = await liveHarness({ callId: 'A' });
  try {
    await h.voice('user', 'u1', '说过的话');
    await h.voice('user', 'u1', '说过的话');
    await h.voice('user', 'u1', '说过的话');
    assert.equal(h.rows().length, 1);
    assert.equal(h.published.length, 1);
  } finally {
    await h.call.stop();
  }
});

test('a replayed committed answer keeps one row and one publication', async () => {
  const a = await liveHarness({ callId: 'A', realtimeSessionId: 'rtc-A' });
  try {
    await a.call.observe({ method: 'turn/started', params: { threadId: a.nativeThreadId, turn: { id: 'turn-1' } } });
    const answer = resultEnvelope('turn-1', 'answer-1', '已回读文档。', a.nativeThreadId);
    await a.call.observe(answer);
    await a.call.observe(answer);
    const results = a.rows().filter((row) => liveOf(row)?.modality === 'result');
    assert.equal(results.length, 1);
    assert.equal(a.published.filter((row) => liveOf(row)?.modality === 'result').length, 1);
    // Let the call reach idle so stop() does not sit on its bounded interrupt wait.
    await a.call.observe({ method: 'turn/completed', params: { threadId: a.nativeThreadId, turn: { id: 'turn-1' } } });
  } finally {
    await a.call.stop();
  }
});

test('replaying committed items under a reconnect binding with a different call id stores nothing new', async () => {
  const binding = {
    userId: OWNER,
    threadId: THREAD,
    catId: createCatId('codex-astra'),
    nativeThreadId: NATIVE_THREAD,
    realtimeSessionId: 'rtc-A',
    nativeTurnId: 'turn-1',
  };
  const store = new MessageStore();
  const spoken = voiceEnvelope('rtc-A', 'user', 'u1', '说过的话');
  const answer = resultEnvelope('turn-1', 'answer-1', '已回读文档。');
  const first = await persistLiveTranscriptItem(store, { ...binding, callId: 'A' }, spoken, identity);
  const firstAnswer = await persistLiveTranscriptItem(store, { ...binding, callId: 'A' }, answer, identity);
  assert.ok(first && firstAnswer);
  assert.equal(await persistLiveTranscriptItem(store, { ...binding, callId: 'A-reconnected' }, spoken), null);
  assert.equal(await persistLiveTranscriptItem(store, { ...binding, callId: 'A-reconnected' }, answer), null);
  const rows = store.getByThread(THREAD, 10, OWNER);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => liveOf(row)?.callId),
    ['A', 'A'],
    'a row keeps the call that first saved it; the reconnect never re-attributes it',
  );
});

test('the same source id with different text is a hard identity conflict and never rewrites the saved row', async () => {
  const h = await liveHarness();
  try {
    await h.voice('user', 'u1', '原话');
    await assert.rejects(h.voice('user', 'u1', '被改写的话'), /identity conflict/);
    await assert.rejects(h.voice('assistant', 'u1', '原话'), /identity conflict/, 'a role flip is also a conflict');
    assert.deepEqual(
      h.rows().map((row) => row.content),
      ['原话'],
    );
  } finally {
    await h.call.stop();
  }
});

test('a typed client id reused with different text is rejected and keeps the first text', async () => {
  const h = await liveHarness();
  try {
    await h.call.sendText('第一句', 'client-1');
    await assert.rejects(h.call.sendText('换了一句', 'client-1'), /identity conflict/);
    assert.deepEqual(
      h.rows().map((row) => row.content),
      ['第一句'],
    );
    assert.equal(h.submitted.length, 1);
  } finally {
    await h.call.stop();
  }
});

// ---------------------------------------------------------------- 未确认重试

test('after a native rejection the retry reuses the saved row; a new client id with the same text is a new message', async () => {
  let attempts = 0;
  const h = await liveHarness({
    submitText: async () => {
      attempts++;
      if (attempts === 1) throw new CodexAppServerRpcError({ method: 'turn/steer', message: 'turn already completed' });
      return 'turn-accepted';
    },
  });
  try {
    await assert.rejects(h.call.sendText('再说一遍', 'client-1'), /turn already completed/);
    const savedId = h.rows()[0]?.id;
    const retry = await h.call.sendText('再说一遍', 'client-1');
    assert.equal(retry.messageId, savedId, 'the retry reuses the durable source');
    assert.equal(h.rows().length, 1);
    const fresh = await h.call.sendText('再说一遍', 'client-2');
    assert.notEqual(fresh.messageId, savedId, 'a deliberate new send is not suppressed by matching text');
    assert.equal(h.rows().length, 2);
  } finally {
    await h.call.stop();
  }
});

test('an ambiguous transport failure keeps its row unexposed, and a different client id is not blocked by it', async () => {
  let attempts = 0;
  const h = await liveHarness({
    submitText: async () => {
      attempts++;
      if (attempts === 1) throw new Error('transport disconnected before acknowledgement');
      return 'turn-accepted';
    },
  });
  try {
    await assert.rejects(h.call.sendText('不确定', 'client-1'), /transport disconnected/);
    const first = h.rows()[0]!;
    assert.equal(h.call.exposureReason(first), null, 'an unconfirmed send is not reported as exposure');
    await assert.rejects(h.call.sendText('不确定', 'client-1'), /transport disconnected/);
    assert.equal(attempts, 1, 'the same id is never blindly resubmitted');
    const other = await h.call.sendText('不确定', 'client-2');
    assert.equal(other.delivery, 'accepted');
    assert.equal(attempts, 2);
    assert.equal(h.call.exposureReason(first), null, 'the unconfirmed row does not borrow the later acceptance');
  } finally {
    await h.call.stop();
  }
});
