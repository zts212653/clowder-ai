// F317 north-star regression harness, fix-boundary probe for 359fc47535 (P3 emoji clip): clipLiveText and the
// projection that uses it. Property-style with a fixed seed, so a failure is reproducible. No media, no visible cat.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoredMessage } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { clipLiveText } from '../src/domains/concierge/live/live-text-budget.js';
import { projectLiveTranscript } from '../src/domains/concierge/live/live-transcript-projection.js';

const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const scope = { userId: 'owner', threadId: 'home', callId: 'call-1' };

/** Small deterministic PRNG (mulberry32) so the "random" strings are the same on every run. */
function prng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ALPHABET = ['a', 'Z', '7', ' ', '猫', '字', '😀', '🐈', '👩‍👩‍👧', '\u{1F1E8}\u{1F1F3}', 'é', '\n'];
function randomText(rand: () => number, units: number) {
  let out = '';
  while (out.length < units) out += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return out;
}

test('clipLiveText: for every limit on many well-formed strings the result is a well-formed prefix that loses at most one unit', () => {
  const rand = prng(20260930);
  for (let round = 0; round < 60; round++) {
    const text = randomText(rand, 40 + Math.floor(rand() * 40));
    assert.equal(LONE.test(text), false, 'the generator itself must produce well-formed text');
    for (let limit = 0; limit <= text.length + 2; limit++) {
      const clipped = clipLiveText(text, limit);
      const context = JSON.stringify({ round, limit });
      assert.equal(text.startsWith(clipped), true, `prefix ${context}`);
      assert.equal(LONE.test(clipped), false, `well-formed ${context}`);
      assert.ok(clipped.length <= limit, `within the limit ${context}`);
      if (limit >= text.length) assert.equal(clipped, text, `whole text when it fits ${context}`);
      else assert.ok(clipped.length >= limit - 1, `drops at most one unit ${context}`);
    }
  }
});

test('clipLiveText: the pair-boundary cases spelled out', () => {
  assert.equal(clipLiveText('😀😀😀', 6), '😀😀😀');
  assert.equal(clipLiveText('😀😀😀', 5), '😀😀', 'a limit inside the third pair backs off to the second');
  assert.equal(clipLiveText('😀😀😀', 4), '😀😀');
  assert.equal(clipLiveText('😀😀😀', 3), '😀');
  assert.equal(clipLiveText('😀😀😀', 1), '', 'nothing fits: empty, never half a character');
  assert.equal(clipLiveText('😀😀😀', 0), '');
  assert.equal(clipLiveText('', 10), '');
  assert.equal(clipLiveText('abc', 2), 'ab');
  assert.equal(clipLiveText('a😀', 2), 'a', 'ASCII then a pair: the pair does not fit in 1 unit');
});

const row = (id: string, text: string): StoredMessage =>
  ({
    id,
    threadId: scope.threadId,
    userId: scope.userId,
    catId: null,
    content: text,
    mentions: [],
    timestamp: 1,
    extra: { liveCompanion: { callId: scope.callId, modality: 'typed', role: 'user', clientMessageId: id } },
  }) as StoredMessage;

test('projection: the odd-budget emoji case is clean, within budget, in order, and honestly flagged', () => {
  const projected = projectLiveTranscript([row('old', '😀'.repeat(10000)), row('new', 'a'.repeat(15001))], scope);
  assert.deepEqual(
    projected.messages.map((m) => m.id),
    ['old', 'new'],
  );
  for (const m of projected.messages) assert.equal(LONE.test(m.text), false);
  assert.ok(projected.messages.reduce((sum, m) => sum + m.text.length, 0) <= 24000);
  assert.equal(projected.messages[0]!.truncated, true);
  assert.equal(projected.hasMore, true);
});

test('projection: a row whose only fitting content would be half a character is dropped, never emitted empty, and hasMore says so', () => {
  // 15999 units leave a budget of 8001 -> then craft a remainder of exactly 1 unit for an emoji-first row.
  const projected = projectLiveTranscript(
    [row('emoji', '😀😀😀'), row('big', 'b'.repeat(16000)), row('mid', 'c'.repeat(7999))],
    scope,
  );
  assert.ok(
    projected.messages.every((m) => m.text.length > 0),
    'no empty caption is ever produced',
  );
  assert.ok(projected.messages.every((m) => !LONE.test(m.text)));
  assert.ok(projected.messages.reduce((sum, m) => sum + m.text.length, 0) <= 24000);
  assert.equal(projected.hasMore, true, 'something was left out');
});

test('projection: many mixed rows never exceed either bound and never break a character', () => {
  const rand = prng(7);
  const rows = Array.from({ length: 50 }, (_, i) => row(`r${i}`, randomText(rand, 200 + Math.floor(rand() * 3000))));
  const projected = projectLiveTranscript(rows, scope);
  assert.ok(projected.messages.length <= 32);
  assert.ok(projected.messages.reduce((sum, m) => sum + m.text.length, 0) <= 24000);
  for (const m of projected.messages) {
    assert.equal(LONE.test(m.text), false);
    assert.ok(m.text.length <= 16000);
    assert.equal(m.truncated, m.text.length !== rows.find((r) => r.id === m.id)!.content.length);
  }
  const ids = projected.messages.map((m) => m.id);
  assert.deepEqual(
    ids,
    rows.map((r) => r.id).filter((id) => ids.includes(id)),
    'source order is kept',
  );
});
