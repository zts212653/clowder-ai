// F317 north-star regression harness, Tier A on the PRODUCTION store: retries and replays must behave the same
// on RedisMessageStore as in memory. Uses only functions that exist before and after the candidate, so the same
// file runs on a control tree and on the candidate. Runs only under the isolated Redis runner; skips elsewhere.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { persistLiveTranscriptItem, persistLiveUserText } from '../src/domains/concierge/live/live-transcript.js';
import { REDIS_SKIP, withRedisStore } from './helpers/f317-ns-reg-redis.js';

const scope = { userId: 'redis-owner', threadId: 'redis-home', callId: 'redis-call' };
const binding = { ...scope, catId: createCatId('codex-astra'), nativeThreadId: 'native', realtimeSessionId: 'rtc' };
const speech = (id: string, role: 'user' | 'assistant', text: string) => ({
  method: 'thread/realtime/item/completed',
  params: { threadId: 'native', item: { id, role, text, type: 'transcriptSegment', realtimeSessionId: 'rtc' } },
});
const opts = { skip: REDIS_SKIP, timeout: 30_000 };

test(
  'a typed send replayed with the same client id is absorbed on the production store, not raised as a conflict',
  opts,
  async () => {
    await withRedisStore(async (store) => {
      const first = await persistLiveUserText(store, scope, '重试的话', 'client-1');
      assert.equal(first.idempotent, false);
      const again = await persistLiveUserText(store, scope, '重试的话', 'client-1');
      assert.equal(again.idempotent, true);
      assert.equal(again.message.id, first.message.id);
      const both = await Promise.all([
        persistLiveUserText(store, scope, '重试的话', 'client-1'),
        persistLiveUserText(store, scope, '重试的话', 'client-1'),
      ]);
      assert.ok(both.every((r) => r.message.id === first.message.id));
      assert.equal((await store.getByThread(scope.threadId, 50, scope.userId)).length, 1);
    });
  },
);

test('the same text under a different client id is a new message on the production store', opts, async () => {
  await withRedisStore(async (store) => {
    const a = await persistLiveUserText(store, scope, '同一句', 'client-a');
    const b = await persistLiveUserText(store, scope, '同一句', 'client-b');
    assert.notEqual(a.message.id, b.message.id);
    assert.equal((await store.getByThread(scope.threadId, 50, scope.userId)).length, 2);
  });
});

test('a typed client id reused with different text still conflicts on the production store', opts, async () => {
  await withRedisStore(async (store) => {
    await persistLiveUserText(store, scope, '第一句', 'client-1');
    await assert.rejects(persistLiveUserText(store, scope, '换了一句', 'client-1'), /identity conflict/);
  });
});

test(
  'a replayed spoken segment is absorbed on the production store and a changed text still conflicts',
  opts,
  async () => {
    await withRedisStore(async (store) => {
      assert.ok(await persistLiveTranscriptItem(store, binding, speech('u1', 'user', '说过的话')));
      assert.equal(await persistLiveTranscriptItem(store, binding, speech('u1', 'user', '说过的话')), null);
      assert.equal(
        await persistLiveTranscriptItem(store, { ...binding, callId: 'reconnected' }, speech('u1', 'user', '说过的话')),
        null,
      );
      await assert.rejects(
        persistLiveTranscriptItem(store, binding, speech('u1', 'user', '被改的话')),
        /identity conflict/,
      );
      assert.equal((await store.getByThread(scope.threadId, 50, scope.userId)).length, 1);
    });
  },
);
