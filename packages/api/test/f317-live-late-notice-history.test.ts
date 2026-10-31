import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LiveLateResultNotices } from '../src/domains/concierge/live/host/live-late-result-notices.js';
import { persistLiveTranscriptItem, persistLiveUserText } from '../src/domains/concierge/live/live-transcript.js';
import { adaptMessageStore } from './helpers/message-from-fixtures.js';

async function fixture() {
  const catId = createCatId('codex61-sol');
  const scope = { userId: 'owner', threadId: 'home', catId, callId: 'old-call' };
  const store = adaptMessageStore(new MessageStore());
  const source = await persistLiveUserText(store, scope, 'compare old SOP and new report', 'source');
  const result = await persistLiveTranscriptItem(
    store,
    { ...scope, nativeThreadId: 'root', realtimeSessionId: 'rtc', nativeTurnId: 'turn' },
    {
      method: 'item/completed',
      params: {
        threadId: 'root',
        turnId: 'turn',
        item: { type: 'agentMessage', phase: 'final_answer', id: 'result', text: 'OLD RESULT BODY' },
      },
    },
    undefined,
    { presentationEligibility: 'deferred', requestRefs: [source.message.id] },
  );
  assert.ok(result);
  let current = true,
    epoch = 1;
  const notices: Array<{ text: string; refs: readonly string[] }> = [];
  const make = (callId = scope.callId) =>
    new LiveLateResultNotices({
      scope: { ...scope, callId },
      store,
      available: () => current,
      epoch: () => epoch,
      verify: async () => current,
      run: async (operation) => operation(),
      publish() {},
      client: () => ({
        request: async () => ({}),
        submitText: async () => 'unused',
        submitContextAtBoundary: async (text, refs, kind, _signal, authorize) => {
          assert.equal(kind, 'late_result_notice');
          assert.equal(await authorize(), true);
          notices.push({ text, refs });
          return 'reminder-turn';
        },
      }),
    });
  return {
    scope,
    store,
    source: source.message,
    result,
    notices,
    make,
    revoke: () => {
      current = false;
    },
    changeTopic: () => {
      epoch++;
    },
  };
}

test('a late result remains one Message projection across stop/reentry; only a ref-only notice is submitted once', async () => {
  const f = await fixture();
  const first = f.make();
  await first.record(f.result);
  await first.defer('turn', 'result', [f.source.id]);
  await first.defer('turn', 'result', [f.source.id]);
  assert.equal(
    (await f.store.getByThread('home')).filter((m) => m.extra?.systemInfo?.payload.phase === 'deferred').length,
    1,
  );
  first.close();
  const reentry = f.make('new-call');
  await reentry.recover();
  assert.equal(reentry.hasPending(), true);
  await reentry.atBoundary();
  await reentry.atBoundary();
  assert.equal(f.notices.length, 1);
  assert.ok(f.notices[0].refs[0].endsWith(`#${f.result.id}`));
  assert.doesNotMatch(f.notices[0].text, /OLD RESULT BODY/);
  assert.equal((await f.store.getById(f.result.id))?.content, 'OLD RESULT BODY');
  const reminder = await persistLiveTranscriptItem(
    f.store,
    {
      ...f.scope,
      callId: 'new-call',
      nativeThreadId: 'new-root',
      realtimeSessionId: 'new-rtc',
      nativeTurnId: 'reminder-turn',
    },
    {
      method: 'item/completed',
      params: {
        threadId: 'new-root',
        turnId: 'reminder-turn',
        item: {
          type: 'agentMessage',
          phase: 'final_answer',
          id: 'reminder',
          text: 'The earlier result is saved; it refers to a different report.',
        },
      },
    },
    undefined,
    { presentationEligibility: 'current', requestRefs: f.notices[0].refs, reminderForMessageIds: [f.result.id] },
  );
  assert.ok(reminder);
  await reentry.record(reminder);
  reentry.close();
  const third = f.make('third-call');
  await third.recover();
  assert.equal(
    third.hasPending(),
    false,
    'input acknowledgement alone never closes a pending reply; the committed reminder does',
  );
  third.close();
});

test('missing source, revocation during lookup, and closed broker cannot submit late work or expose its body', async () => {
  const f = await fixture();
  const broker = f.make();
  await broker.record(f.result);
  await broker.defer('turn', 'result', ['foreign#source']);
  assert.equal(broker.hasPending(), false);
  await broker.defer('turn', 'result', [f.source.id]);
  const get = f.store.getById.bind(f.store);
  Object.defineProperty(f.store, 'getById', {
    value: async (id: string) => {
      f.revoke();
      return get(id);
    },
  });
  await broker.atBoundary();
  assert.equal(f.notices.length, 0);
  broker.close();
  await broker.atBoundary();
  assert.equal(f.notices.length, 0);
});
