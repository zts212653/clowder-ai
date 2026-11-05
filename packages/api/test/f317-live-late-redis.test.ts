import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { type IMessageStore, MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import { LiveLateResultNotices } from '../src/domains/concierge/live/host/live-late-result-notices.js';
import { REDIS_SKIP, withRedisStore } from './helpers/f317-ns-reg-redis.js';

type Store = Pick<IMessageStore, 'appendIdempotent' | 'getById' | 'getByThread'>;
const scope = { userId: 'owner', threadId: 'home', catId: createCatId('codex61-sol'), callId: 'new-call' };
const live = {
  callId: 'original-call',
  nativeThreadId: 'root',
  realtimeSessionId: 'rtc',
  nativeItemId: 'item',
  nativeTurnId: 'turn',
  modality: 'result' as const,
};

async function roundTrip(write: Store, read: Store, projection: boolean) {
  const source = (
    await write.appendIdempotent({
      userId: 'owner',
      threadId: 'home',
      from: { kind: 'user', userId: 'owner' },
      content: 'Compare the original reports',
      mentions: [],
      timestamp: Date.now(),
      idempotencyKey: 'source',
      extra: {
        liveCompanion: { callId: live.callId, modality: 'typed', role: 'user', clientMessageId: 'source-client' },
      },
    })
  ).message;
  const refs = [`thread:home#${source.id}`];
  const result = (
    await write.appendIdempotent({
      userId: 'owner',
      threadId: 'home',
      from: { kind: 'agent', catId: scope.catId },
      content: 'Original complete result',
      mentions: [],
      timestamp: Date.now(),
      idempotencyKey: 'result',
      extra: {
        liveCompanion: {
          ...live,
          ...(projection
            ? { returnProjection: { presentationEligibility: 'deferred' as const, requestRefs: refs } }
            : {}),
        },
      },
    })
  ).message;
  if (!projection)
    await write.appendIdempotent({
      userId: 'owner',
      threadId: 'home',
      from: { kind: 'system', service: 'legacy-briefing' },
      content: 'Deferred result fact',
      mentions: [],
      origin: 'briefing',
      timestamp: Date.now(),
      idempotencyKey: 'deferred-fact',
      extra: {
        systemKind: 'context_briefing',
        systemInfo: {
          v: 1,
          payload: { kind: 'live_result_notice', phase: 'deferred', resultMessageId: result.id, requestRefs: refs },
        },
      },
    });
  const restored = await read.getById(result.id);
  if (projection)
    assert.deepEqual(
      restored?.extra?.liveCompanion?.modality === 'result' && restored.extra.liveCompanion.returnProjection,
      { presentationEligibility: 'deferred', requestRefs: refs },
    );
  else
    assert.equal(
      (await read.getByThread('home', 120, 'owner')).find((m) => m.from.kind === 'system')?.extra?.systemInfo?.payload
        .kind,
      'live_result_notice',
    );
  let woke = 0;
  const make = () =>
    new LiveLateResultNotices({
      scope,
      store: read,
      available: () => true,
      epoch: () => 1,
      verify: async () => true,
      client: () => ({
        request: async () => ({}),
        submitText: async () => 'turn',
        wakeBoundary: () => {
          woke++;
        },
      }),
      run: async (operation) => operation(),
      publish() {},
    });
  const second = make();
  await second.recover();
  assert.equal(second.hasPending(), true);
  assert.equal(woke, 1);
  const reminder = (
    await write.appendIdempotent({
      userId: 'owner',
      threadId: 'home',
      from: { kind: 'agent', catId: scope.catId },
      content: 'Current source-backed reminder',
      mentions: [],
      timestamp: Date.now(),
      idempotencyKey: 'reminder',
      extra: {
        liveCompanion: {
          ...live,
          callId: scope.callId,
          nativeItemId: 'reminder-item',
          returnProjection: {
            presentationEligibility: 'current',
            requestRefs: [`thread:home#${result.id}`, ...refs],
            reminderForMessageIds: [result.id],
          },
        },
      },
    })
  ).message;
  await second.record(reminder);
  second.close();
  const savedReminder = await read.getById(reminder.id);
  assert.deepEqual(
    savedReminder?.extra?.liveCompanion?.modality === 'result' &&
      savedReminder.extra.liveCompanion.returnProjection?.reminderForMessageIds,
    [result.id],
  );
  const third = make();
  await third.recover();
  assert.equal(third.hasPending(), false, 'committed reminder remains resolved after another reader/reentry');
  assert.equal(woke, 1);
  third.close();
}

for (const projection of [true, false]) {
  test(`memory control recovers ${projection ? 'original projection' : 'deferred fact'} and persists reminder resolution`, async () => {
    const store = new MessageStore();
    await roundTrip(store, store, projection);
  });
  test(
    `Redis reader recovers ${projection ? 'original projection' : 'deferred fact'} and persists reminder resolution`,
    { skip: REDIS_SKIP, timeout: 60000 },
    async () => {
      await withRedisStore(async (store, redis) => roundTrip(store, new RedisMessageStore(redis), projection));
    },
  );
}
