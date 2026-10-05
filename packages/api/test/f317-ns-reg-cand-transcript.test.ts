// F317 north-star regression harness, Tier B bound to candidate d5d293aa2e (projectLiveTranscript).
// Adversarial complement to the author's f317-live-transcript-projection.test.ts: rows come from the REAL
// call code paths where possible, damaged/forged metadata is built by hand, and the bounds are probed at
// their edges. No media, no visible cat.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoredMessage } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { projectLiveTranscript } from '../src/domains/concierge/live/live-transcript-projection.js';
import { liveHarness, OWNER, THREAD } from './helpers/f317-ns-reg-live.js';

const scopeOf = (callId: string) => ({ userId: OWNER, threadId: THREAD, callId });
/** A high surrogate without its low half, or a low surrogate without its high half. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

let counter = 0;
function row(over: Partial<StoredMessage> & { live?: unknown; content?: string } = {}): StoredMessage {
  const { live, ...rest } = over;
  return {
    id: `row-${++counter}`,
    threadId: THREAD,
    userId: OWNER,
    catId: null,
    content: '你好',
    mentions: [],
    timestamp: 1_000 + counter,
    ...rest,
    ...(live === undefined ? {} : { extra: { liveCompanion: live } }),
  } as StoredMessage;
}
const typed = (callId: string, clientMessageId: string, over: Partial<StoredMessage> = {}) =>
  row({ live: { callId, modality: 'typed', role: 'user', clientMessageId }, ...over });
const voice = (callId: string, itemId: string, role: 'user' | 'assistant', over: Partial<StoredMessage> = {}) =>
  row({
    catId: role === 'user' ? null : ('codex-astra' as never),
    live: {
      callId,
      modality: 'voice',
      role,
      nativeThreadId: 'native',
      realtimeSessionId: 'rtc',
      nativeItemId: itemId,
    },
    ...over,
  });

// ------------------------------------------------- rows written by the real call, not hand-built

test('rows the real call wrote — speech both ways and typing — project in store order with exact source facts', async () => {
  const h = await liveHarness({ callId: 'call-1' });
  try {
    await h.voice('user', 'u1', '你好');
    await h.call.sendText('打字', 'client-1');
    await h.voice('assistant', 'a1', '我在');
    const projected = projectLiveTranscript(h.rows(), scopeOf('call-1'));
    assert.deepEqual(
      projected.messages.map((m) => [m.role, m.source.kind, m.text]),
      [
        ['user', 'voice', '你好'],
        ['user', 'typed', '打字'],
        ['assistant', 'voice', '我在'],
      ],
    );
    assert.deepEqual(
      projected.messages.map((m) => m.id),
      h.rows().map((r) => r.id),
      'the ids are the saved message ids, in the store order',
    );
    const [spoken, written] = projected.messages;
    assert.equal(spoken!.source.kind === 'voice' && spoken!.source.nativeItemId, 'u1');
    assert.equal(written!.source.kind === 'typed' && written!.source.clientMessageId, 'client-1');
    assert.ok(projected.messages.every((m) => m.source.callId === 'call-1' && m.truncated === false));
    assert.equal(projected.hasMore, false);
  } finally {
    await h.call.stop();
  }
});

test('a committed result answer of the same call, and text sent through the call, never swap places', async () => {
  const h = await liveHarness({ callId: 'call-1' });
  try {
    await h.call.observe({ method: 'turn/started', params: { threadId: h.nativeThreadId, turn: { id: 't1' } } });
    await h.call.observe({
      method: 'item/completed',
      params: {
        threadId: h.nativeThreadId,
        turnId: 't1',
        item: { type: 'agentMessage', id: 'r1', phase: 'final_answer', text: '后台回答' },
      },
    });
    await h.call.observe({ method: 'turn/completed', params: { threadId: h.nativeThreadId, turn: { id: 't1' } } });
    await h.voice('assistant', 'a1', '后台回答'); // identical text, different modality
    const all = h.rows();
    assert.equal(all.length, 2, 'both rows exist in the complete chat');
    const projected = projectLiveTranscript(all, scopeOf('call-1'));
    assert.equal(projected.messages.length, 1);
    assert.equal(projected.messages[0]!.source.kind === 'voice' && projected.messages[0]!.source.nativeItemId, 'a1');
  } finally {
    await h.call.stop();
  }
});

test('two calls in one thread stay disjoint, and a reconnect replay never moves a row to the newer call', async () => {
  const a = await liveHarness({ callId: 'A', realtimeSessionId: 'rtc-A' });
  await a.voice('user', 'a1', 'A 说的');
  await a.call.sendText('A 打的', 'ca');
  await a.call.stop();
  const b = await liveHarness({ callId: 'B', realtimeSessionId: 'rtc-B', store: a.store });
  try {
    await b.voice('user', 'b1', 'B 说的');
    await b.foreignVoice('rtc-A', 'user', 'a1', 'A 说的'); // replay of A's committed item into B
    const rows = b.rows();
    assert.deepEqual(
      projectLiveTranscript(rows, scopeOf('A')).messages.map((m) => m.text),
      ['A 说的', 'A 打的'],
    );
    assert.deepEqual(
      projectLiveTranscript(rows, scopeOf('B')).messages.map((m) => m.text),
      ['B 说的'],
    );
  } finally {
    await b.call.stop();
  }
});

// ------------------------------------------------- forged or damaged metadata is refused, not repaired

test('damaged, forged, foreign and retracted rows are all refused; the one valid row survives', () => {
  const scope = scopeOf('call-1');
  const good = typed('call-1', 'ok');
  const refused: StoredMessage[] = [
    voice('call-1', 'forged-1', 'user', { catId: 'codex-astra' as never }), // says user, has a cat author
    voice('call-1', 'forged-2', 'assistant', { catId: null }), // says assistant, has no cat author
    row({
      live: {
        callId: 'call-1',
        modality: 'voice',
        nativeThreadId: 'n',
        realtimeSessionId: 'r',
        nativeItemId: 'legacy',
      },
    }), // no role
    row({
      live: {
        callId: 'call-1',
        modality: 'result',
        role: 'assistant',
        nativeThreadId: 'n',
        realtimeSessionId: 'r',
        nativeItemId: 'res',
      },
      catId: 'codex-astra' as never,
    }),
    row({ live: { callId: 'call-1', modality: 'typed', role: 'user' } }), // typed without its client id
    row({ live: { callId: 'call-1', modality: 'typed', role: 'assistant', clientMessageId: 'x' } }), // typed cannot be a cat
    voice('call-1', 'bad/id', 'user'),
    voice('call-1', 'x'.repeat(161), 'user'),
    typed('call-2', 'other-call'),
    typed('call-1', 'other-user', { userId: 'someone-else' }),
    typed('call-1', 'other-thread', { threadId: 'other-thread' }),
    typed('call-1', 'deleted', { deletedAt: 5 } as Partial<StoredMessage>),
    typed('call-1', 'blank', { content: '  \n\t ' }),
    row({ live: 'not-an-object' }),
    row(),
  ];
  const projected = projectLiveTranscript([...refused, good], scope);
  assert.deepEqual(
    projected.messages.map((m) => m.id),
    [good.id],
  );
  assert.equal(projected.hasMore, false, 'refusing rows is not the same as omitting history');
});

test('projection is a pure read: it neither mutates the rows nor hands out references into them', () => {
  const rows = [typed('call-1', 'c1'), voice('call-1', 'u1', 'user')];
  const before = JSON.stringify(rows);
  const first = projectLiveTranscript(rows, scopeOf('call-1'));
  assert.equal(JSON.stringify(rows), before);
  first.messages[0]!.text = 'tampered';
  (first.messages[0]!.source as { callId: string }).callId = 'tampered';
  assert.equal(JSON.stringify(rows), before, 'editing the result cannot reach the saved rows');
  assert.deepEqual(projectLiveTranscript(rows, scopeOf('call-1')), projectLiveTranscript(rows, scopeOf('call-1')));
});

test('the projection exposes only its documented fields: no identity snapshot, author, mentions or clock', () => {
  const identityRow = voice('call-1', 'u1', 'user');
  (identityRow.extra!.liveCompanion as { identity?: unknown }).identity = { name: 'private-face' };
  (identityRow as unknown as { mentions: string[] }).mentions = ['someone'];
  const projected = projectLiveTranscript([identityRow, typed('call-1', 'c1')], scopeOf('call-1'));
  for (const message of projected.messages) {
    assert.deepEqual(Object.keys(message).sort(), ['id', 'role', 'source', 'text', 'truncated']);
  }
  assert.deepEqual(Object.keys(projected.messages[0]!.source).sort(), [
    'callId',
    'kind',
    'nativeItemId',
    'nativeThreadId',
    'realtimeSessionId',
  ]);
  assert.deepEqual(Object.keys(projected.messages[1]!.source).sort(), ['callId', 'clientMessageId', 'kind']);
  assert.deepEqual(Object.keys(projected).sort(), ['callId', 'hasMore', 'messages']);
  const wire = JSON.stringify(projected);
  for (const leaked of ['private-face', 'identity', 'someone', 'timestamp', 'catId']) {
    assert.equal(wire.includes(leaked), false, `${leaked} must not appear`);
  }
});

// ------------------------------------------------- bounds, probed at their edges

test('row count: 32 fit, the 33rd makes hasMore true and drops the OLDEST; source order is kept', () => {
  const rows = Array.from({ length: 33 }, (_, i) => typed('call-1', `c${i}`, { content: `第 ${i} 句` }));
  const full = projectLiveTranscript(rows.slice(1), scopeOf('call-1'));
  assert.equal(full.messages.length, 32);
  assert.equal(full.hasMore, false);
  const over = projectLiveTranscript(rows, scopeOf('call-1'));
  assert.equal(over.messages.length, 32);
  assert.equal(over.hasMore, true);
  assert.deepEqual(
    over.messages.map((m) => m.id),
    rows.slice(1).map((r) => r.id),
  );
});

test('text budget: one row exactly at 16000 is whole; 16001 is clipped and flagged; the flag is per row', () => {
  const exact = projectLiveTranscript([typed('call-1', 'a', { content: 'x'.repeat(16000) })], scopeOf('call-1'));
  assert.equal(exact.messages[0]!.text.length, 16000);
  assert.equal(exact.messages[0]!.truncated, false);
  assert.equal(exact.hasMore, false);
  const clipped = projectLiveTranscript([typed('call-1', 'a', { content: 'x'.repeat(16001) })], scopeOf('call-1'));
  assert.equal(clipped.messages[0]!.text.length, 16000);
  assert.equal(clipped.messages[0]!.truncated, true);
  assert.equal(clipped.hasMore, true);
  const mixed = projectLiveTranscript(
    [typed('call-1', 'old', { content: 'short' }), typed('call-1', 'new', { content: 'y'.repeat(16001) })],
    scopeOf('call-1'),
  );
  assert.deepEqual(
    mixed.messages.map((m) => m.truncated),
    [false, true],
  );
});

test('total budget 24000: the newest rows are kept whole first; the row that crosses it is clipped; the rest are dropped and hasMore says so', () => {
  const exactFit = projectLiveTranscript(
    [typed('call-1', 'o', { content: 'o'.repeat(12000) }), typed('call-1', 'n', { content: 'n'.repeat(12000) })],
    scopeOf('call-1'),
  );
  assert.equal(exactFit.messages.length, 2);
  assert.equal(exactFit.hasMore, false, 'exactly 24000 fits without claiming more');

  const rows = ['a', 'b', 'c', 'd'].map((c) => typed('call-1', c, { content: c.repeat(10000) }));
  const projected = projectLiveTranscript(rows, scopeOf('call-1'));
  const total = projected.messages.reduce((sum, m) => sum + m.text.length, 0);
  assert.equal(total, 24000);
  assert.deepEqual(
    projected.messages.map((m) => [m.text[0], m.text.length, m.truncated]),
    [
      ['b', 4000, true],
      ['c', 10000, false],
      ['d', 10000, false],
    ],
    'newest rows are whole, the row that crosses the budget is the clipped one, older rows are dropped',
  );
  assert.equal(projected.hasMore, true);
  assert.ok(
    !projected.messages.some((m) => m.text[0] === 'a'),
    'rows beyond the budget are dropped, not squeezed to nothing',
  );
});

test('a scan that already hit its limit is reported as more history even when nothing matched', () => {
  const none = projectLiveTranscript([row()], scopeOf('call-1'), true);
  assert.deepEqual(none.messages, []);
  assert.equal(none.hasMore, true);
});

test('clipping never leaves a broken character (surrogate pair cut in half)', () => {
  // 15001 ASCII newest, then emoji: the remaining budget is odd (8999), so a raw slice lands inside a pair.
  const rows = [
    typed('call-1', 'emoji', { content: '😀'.repeat(10000) }),
    typed('call-1', 'ascii', { content: 'a'.repeat(15001) }),
  ];
  const projected = projectLiveTranscript(rows, scopeOf('call-1'));
  for (const message of projected.messages) {
    assert.equal(LONE_SURROGATE.test(message.text), false, 'clipped text must remain well-formed UTF-16');
  }
});
