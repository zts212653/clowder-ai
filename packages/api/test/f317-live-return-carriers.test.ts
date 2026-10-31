import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeParseExtra } from '../src/domains/cats/services/stores/redis/redis-message-parsers.js';

const carrier = {
  callId: 'call',
  nativeThreadId: 'root',
  realtimeSessionId: 'rtc',
  nativeItemId: 'item',
  nativeTurnId: 'turn',
  modality: 'result',
  role: 'assistant',
};
const projection = { presentationEligibility: 'deferred', requestRefs: ['thread:home#owner'] };
const parsed = (value: unknown) =>
  safeParseExtra(JSON.stringify({ liveCompanion: { ...carrier, returnProjection: value } }))?.liveCompanion;

test('only bounded strict return qualification survives; invalid metadata does not discard the original carrier', () => {
  for (const value of [
    null,
    { ...projection, presentationEligibility: 'visible' },
    { ...projection, requestRefs: 'message' },
    { ...projection, requestRefs: Array(33).fill('ref') },
    { ...projection, requestRefs: ['x'.repeat(513)] },
    { ...projection, requestRefs: ['unsafe\nref'] },
    { ...projection, reminderForMessageIds: ['bad\u0085ref'] },
    { ...projection, authority: 'forged' },
  ]) {
    const read = parsed(value);
    assert.equal(read?.modality, 'result');
    assert.equal(read?.modality === 'result' && read.returnProjection, undefined);
  }
  const valid = { ...projection, requestRefs: Array(32).fill('x'.repeat(512)), reminderForMessageIds: ['result'] };
  const read = parsed(valid);
  assert.deepEqual(read?.modality === 'result' && read.returnProjection, valid);
});

test('only complete strict Live notice facts use the context briefing payload carrier', () => {
  const fact = {
    kind: 'live_result_notice',
    phase: 'deferred',
    resultMessageId: 'result',
    requestRefs: ['thread:home#owner'],
  };
  const parse = (payload: unknown, systemKind = 'context_briefing') =>
    safeParseExtra(JSON.stringify({ systemKind, systemInfo: { v: 1, payload } }));
  assert.deepEqual(parse(fact)?.systemInfo?.payload, fact);
  assert.deepEqual(
    parse({ ...fact, phase: 'reminder_committed', requestRefs: [], reminderMessageId: 'reminder' })?.systemInfo?.payload
      .phase,
    'reminder_committed',
  );
  for (const payload of [
    { ...fact, phase: 'speech_sent' },
    { ...fact, requestRefs: [] },
    { ...fact, phase: 'reminder_committed' },
    { ...fact, resultMessageId: 'bad\u0000id' },
    { ...fact, requestRefs: Array(33).fill('ref') },
    { ...fact, rootAuthority: 'forged' },
  ])
    assert.equal(parse(payload)?.systemInfo, undefined);
  assert.equal(parse(fact, 'a2a_routing')?.systemInfo, undefined);
});
