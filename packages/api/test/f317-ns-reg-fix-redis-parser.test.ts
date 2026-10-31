// F317 north-star regression harness, fix-boundary probe for 359fc47535 (P1-1): what the production Redis store's
// read-side parser keeps, drops and refuses to invent for extra.liveCompanion. Rows are written with arbitrary
// (including malformed) metadata straight through appendIdempotent, so this checks the PARSER, not the Host writers.
// Runs only under the isolated Redis runner (never 6397/6398/6399/6401); skips elsewhere. No media, no visible cat.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCompanionIdentitySnapshot } from '@cat-cafe/shared';
import { REDIS_SKIP, withRedisStore } from './helpers/f317-ns-reg-redis.js';

const identity = createCompanionIdentitySnapshot({
  duty: { catId: 'fable-5', displayName: '宪宪' },
  carrier: { catId: 'codex-astra', displayName: '砚砚' },
  skin: 'black-cat',
  liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
});
const typedOk = { callId: 'call-1', modality: 'typed', role: 'user', clientMessageId: 'client-1' };
const voiceOk = {
  callId: 'call-1',
  modality: 'voice',
  nativeThreadId: 'native',
  realtimeSessionId: 'rtc',
  nativeItemId: 'item-1',
};

type Case = readonly [label: string, stored: unknown, expected: unknown];
const KEEP = Symbol('keep as written');
const cases: readonly Case[] = [
  ['typed valid', typedOk, KEEP],
  ['typed valid with identity', { ...typedOk, identity }, { ...typedOk, identity }],
  ['typed with an unknown extra field', { ...typedOk, evil: 'x', nativeItemId: 'leak' }, typedOk],
  ['typed role assistant', { ...typedOk, role: 'assistant' }, undefined],
  ['typed role system', { ...typedOk, role: 'system' }, undefined],
  ['typed without role', { ...typedOk, role: undefined }, undefined],
  ['typed empty client id', { ...typedOk, clientMessageId: '' }, undefined],
  ['typed client id 256', { ...typedOk, clientMessageId: 'x'.repeat(256) }, KEEP],
  ['typed client id 257', { ...typedOk, clientMessageId: 'x'.repeat(257) }, undefined],
  ['typed client id number', { ...typedOk, clientMessageId: 7 }, undefined],
  ['typed call id with a slash', { ...typedOk, callId: 'a/b' }, undefined],
  ['typed empty call id', { ...typedOk, callId: '' }, undefined],
  ['typed call id 161', { ...typedOk, callId: 'c'.repeat(161) }, undefined],
  ['voice legacy without role (never guessed)', voiceOk, voiceOk],
  ['voice role user', { ...voiceOk, role: 'user' }, KEEP],
  ['voice role assistant', { ...voiceOk, role: 'assistant' }, KEEP],
  ['voice role system (row kept, role not invented)', { ...voiceOk, role: 'system' }, voiceOk],
  ['voice role number', { ...voiceOk, role: 5 }, voiceOk],
  ['voice with a turn id', { ...voiceOk, role: 'user', nativeTurnId: 'turn-1' }, undefined],
  ['voice with a bad item id', { ...voiceOk, role: 'user', nativeItemId: 'bad/id' }, undefined],
  ['result with role and turn', { ...voiceOk, modality: 'result', role: 'assistant', nativeTurnId: 'turn-1' }, KEEP],
  ['result without a turn id', { ...voiceOk, modality: 'result', role: 'assistant' }, undefined],
  ['unknown modality', { ...voiceOk, modality: 'video' }, undefined],
  ['a string', 'typed', undefined],
  ['an array', [typedOk], undefined],
  ['null', null, undefined],
];

test(
  'the Redis read-side parser keeps exactly the valid shapes, drops malformed ones, never throws and never invents a role',
  { skip: REDIS_SKIP, timeout: 60_000 },
  async () => {
    await withRedisStore(async (store) => {
      const scope = { userId: 'redis-owner', threadId: 'redis-home' };
      for (const [label, stored] of cases) {
        await store.appendIdempotent({
          ...scope,
          catId: null,
          content: label,
          mentions: [],
          timestamp: Date.now(),
          idempotencyKey: `parser-${label}`,
          extra: { liveCompanion: stored as never },
        } as never);
      }
      const rows = await store.getByThread(scope.threadId, 256, scope.userId);
      assert.equal(rows.length, cases.length, 'every row is still readable, however malformed its metadata');
      const byLabel = new Map(rows.map((r) => [r.content, r.extra?.liveCompanion]));
      for (const [label, stored, expected] of cases) {
        const want = expected === KEEP ? stored : expected;
        assert.deepEqual(byLabel.get(label), want, label);
      }
    });
  },
);
