// F317 north-star regression harness, fix-boundary probe for 359fc47535 (P1-2): the EXACT set of messages the
// page-action authority accepts as a "direct owner request". Expectations are written from the plan, not from the
// implementation: only the owner's own typed text in THIS call qualifies; speech, results, other calls, bad roles,
// cat authors and every pre-existing exclusion must keep failing. No media, no visible cat.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoredMessage } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { directOwner } from '../src/domains/concierge/live/host/live-page-action-authority-contract.js';
import { scope } from './helpers/f317-page-action-fixture.js';

let counter = 0;
function message(over: Record<string, unknown> = {}, live?: unknown): StoredMessage {
  return {
    id: `m-${++counter}`,
    threadId: scope.threadId,
    userId: scope.userId,
    catId: null,
    content: 'Fill the approved note',
    mentions: [],
    timestamp: 1_000 + counter,
    ...over,
    ...(live === undefined ? {} : { extra: { ...((over.extra as object) ?? {}), liveCompanion: live } }),
  } as StoredMessage;
}
const typed = (over: Record<string, unknown> = {}, live: Record<string, unknown> = {}) =>
  message(over, { callId: scope.callId, modality: 'typed', role: 'user', clientMessageId: 'client-1', ...live });

test("accepted: the owner's own typed text in this call, and nothing else that carries liveCompanion", () => {
  assert.equal(directOwner(typed(), scope), true);
  assert.equal(
    directOwner(typed({}, { clientMessageId: 'x'.repeat(256) }), scope),
    true,
    '256 is the documented limit',
  );
});

test('rejected: a typed row that is not exactly this owner, in this call, with a usable client id', () => {
  const rejected: Array<[string, StoredMessage]> = [
    ['another call', typed({}, { callId: 'some-other-call' })],
    ['an earlier call of the same thread', typed({}, { callId: 'call-from-yesterday' })],
    ['role assistant', typed({}, { role: 'assistant' })],
    ['no role', typed({}, { role: undefined })],
    ['a bogus role', typed({}, { role: 'system' })],
    ['client id missing', typed({}, { clientMessageId: undefined })],
    ['client id blank', typed({}, { clientMessageId: '   ' })],
    ['client id empty', typed({}, { clientMessageId: '' })],
    ['client id 257 long', typed({}, { clientMessageId: 'x'.repeat(257) })],
    ['client id not a string', typed({}, { clientMessageId: 42 })],
    ['a cat as author', typed({ catId: 'codex-astra' })],
    ['another owner', typed({ userId: 'someone-else' })],
    ['another thread', typed({ threadId: 'other-thread' })],
    ['soft-deleted', typed({ deletedAt: 5 })],
    ['recalled', typed({ recall: { at: 1 } })],
    ['queued', typed({ deliveryStatus: 'queued' })],
    ['canceled', typed({ deliveryStatus: 'canceled' })],
    ['a whisper', typed({ visibility: 'whisper' })],
    ['a connector source', typed({ source: { connector: 'x', label: 'x', icon: 'x' } })],
    ['cross-posted', typed({ extra: { crossPost: { sourceThreadId: 'elsewhere' } } })],
    [
      'a realtime companion row',
      typed({ extra: { realtimeCompanion: { consumer: 'x', invocationId: 'realtime-companion-1' } } }),
    ],
  ];
  for (const [why, row] of rejected) assert.equal(directOwner(row, scope), false, why);
});

test('rejected: speech and results of this very call, whatever role they claim', () => {
  const voice = (role: string, over: Record<string, unknown> = {}) =>
    message(over, {
      callId: scope.callId,
      modality: 'voice',
      role,
      nativeThreadId: 'n',
      realtimeSessionId: 'r',
      nativeItemId: 'i1',
    });
  assert.equal(directOwner(voice('user'), scope), false, 'the owner speaking is still not a typed direct request');
  assert.equal(directOwner(voice('assistant', { catId: 'codex-astra' }), scope), false);
  assert.equal(directOwner(voice(undefined as never), scope), false, 'legacy speech without a role');
  const result = message(
    { catId: 'codex-astra' },
    {
      callId: scope.callId,
      modality: 'result',
      role: 'assistant',
      nativeThreadId: 'n',
      realtimeSessionId: 'r',
      nativeItemId: 'i2',
      nativeTurnId: 't',
    },
  );
  assert.equal(directOwner(result, scope), false);
  assert.equal(directOwner(message({}, { callId: scope.callId }), scope), false, 'a liveCompanion with no modality');
  assert.equal(directOwner(message({}, 'typed'), scope), false, 'a non-object liveCompanion');
  assert.equal(directOwner(message({}, null as never), scope), true, 'null is "no liveCompanion", same as before');
});

test('unchanged: ordinary owner text without any liveCompanion still qualifies, and every old exclusion still applies', () => {
  assert.equal(directOwner(message(), scope), true);
  assert.equal(directOwner(message({ userId: 'someone-else' }), scope), false);
  assert.equal(directOwner(message({ catId: 'codex-astra' }), scope), false);
  assert.equal(directOwner(message({ deliveryStatus: 'queued' }), scope), false);
});

test('a typed row is judged against the CURRENT call, so the same row stops qualifying when the scope moves on', () => {
  const row = typed();
  assert.equal(directOwner(row, scope), true);
  assert.equal(directOwner(row, { ...scope, callId: 'the-next-call' }), false);
});
