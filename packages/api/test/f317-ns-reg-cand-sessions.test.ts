// F317 north-star regression harness, Tier B bound to candidate d5d293aa2e
// (LiveCompanionSessions.withOwnerPreferenceChange). The author pins the happy serialisation and the
// unconfirmed-teardown refusal; this file probes what happens when the save fails, when there is nothing to
// stop, when another user is involved, and when the callback re-enters. No media, no visible cat.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import type { LiveCompanionCall } from '../src/domains/concierge/live/LiveCompanionCall.js';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.js';

const options = (userId: string, callId: string) => ({
  binding: { userId, threadId: `${userId}-home`, catId: createCatId('codex-astra'), callId },
  messageStore: new MessageStore(),
  mcpDistDir: resolve('../mcp-server/dist'),
  allowedDirectories: [],
  verifyNativeBinding: async () => true,
  publish() {},
});

/** Prepare a call and (optionally) bring it to talking, over an in-process native transport. */
async function prepared(sessions: LiveCompanionSessions, userId: string, callId: string, talk = true) {
  const call: LiveCompanionCall = await sessions.prepare(options(userId, callId));
  await call.ready('native', {
    submitText: async () => 'turn',
    request: async (method) => {
      if (method === 'thread/realtime/start')
        await call.observe({ method: 'thread/realtime/sdp', params: { threadId: 'native', sdp: 'answer' } });
      if (method === 'thread/realtime/stop')
        await call.observe({ method: 'thread/realtime/closed', params: { threadId: 'native' } });
      return {};
    },
  });
  if (talk) await call.start('offer');
  return call;
}

test('with no call to stop the save runs at once, its value comes back, and the fence is released', async () => {
  const sessions = new LiveCompanionSessions();
  assert.equal(await sessions.withOwnerPreferenceChange('owner', async () => 'saved'), 'saved');
  const next = await prepared(sessions, 'owner', 'call-1');
  assert.equal(next.status().state, 'talking');
  await next.stop();
});

test('a failing save reaches the caller unchanged, leaves the call closed, and does not strand the fence', async () => {
  const sessions = new LiveCompanionSessions();
  const call = await prepared(sessions, 'owner', 'call-1');
  const failure = new Error('config store down');
  await assert.rejects(
    sessions.withOwnerPreferenceChange('owner', async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(call.status().state, 'closed', 'the call stayed closed; nothing silently resumed it');
  const next = await prepared(sessions, 'owner', 'call-2');
  assert.equal(next.status().state, 'talking', 'the owner can start again after a failed save');
  await next.stop();
});

test('a call that is ready but not yet talking is also stopped before the save', async () => {
  const sessions = new LiveCompanionSessions();
  const call = await prepared(sessions, 'owner', 'call-1', false);
  assert.equal(call.status().state, 'ready');
  let seenInSave = '';
  await sessions.withOwnerPreferenceChange('owner', async () => {
    seenInSave = call.status().state;
  });
  assert.equal(seenInSave, 'closed');
});

test('the fence belongs to one owner: another user keeps their call and can still start one', async () => {
  const sessions = new LiveCompanionSessions();
  const mine = await prepared(sessions, 'owner', 'call-mine');
  const theirs = await prepared(sessions, 'other', 'call-theirs');
  let theirStateInSave = '';
  let newcomer: LiveCompanionCall | undefined;
  await sessions.withOwnerPreferenceChange('owner', async () => {
    theirStateInSave = theirs.status().state;
    newcomer = await prepared(sessions, 'third', 'call-third');
  });
  assert.equal(mine.status().state, 'closed');
  assert.equal(theirStateInSave, 'talking', 'someone else’s call is not touched by my permission change');
  assert.equal(theirs.status().state, 'talking');
  assert.equal(newcomer?.status().state, 'talking');
  await theirs.stop();
  await newcomer?.stop();
});

test('a save that tries to open the fence again is refused instead of deadlocking', async () => {
  const sessions = new LiveCompanionSessions();
  await prepared(sessions, 'owner', 'call-1');
  let inner: unknown;
  await sessions.withOwnerPreferenceChange('owner', async () => {
    inner = await sessions.withOwnerPreferenceChange('owner', async () => 'nested').catch((error: unknown) => error);
  });
  assert.match(String((inner as Error)?.message), /active/i);
});

test('changes run one after another, each stopping what exists and each releasing the fence', async () => {
  const sessions = new LiveCompanionSessions();
  const order: string[] = [];
  const first = await prepared(sessions, 'owner', 'call-1');
  await sessions.withOwnerPreferenceChange('owner', async () => {
    order.push(`first:${first.status().state}`);
  });
  const second = await prepared(sessions, 'owner', 'call-2');
  await sessions.withOwnerPreferenceChange('owner', async () => {
    order.push(`second:${second.status().state}`);
  });
  assert.deepEqual(order, ['first:closed', 'second:closed']);
});
