// F317 north-star regression harness, Tier B bound to candidate d5d293aa2e: the new source metadata and the
// projection through the REAL RedisMessageStore. In-memory green does not prove Redis green: the Redis store
// reads `extra` back through its own field-by-field parser (redis-message-parsers.ts). Runs only under the
// isolated Redis runner; skips elsewhere. No media, no visible cat.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { persistLiveTranscriptItem, persistLiveUserText } from '../src/domains/concierge/live/live-transcript.js';
import { projectLiveTranscript } from '../src/domains/concierge/live/live-transcript-projection.js';
import { REDIS_SKIP, withRedisStore } from './helpers/f317-ns-reg-redis.js';

const scope = { userId: 'redis-owner', threadId: 'redis-home', callId: 'redis-call' };
const binding = { ...scope, catId: createCatId('codex-astra'), nativeThreadId: 'native', realtimeSessionId: 'rtc' };
const speech = (id: string, role: 'user' | 'assistant', text: string) => ({
  method: 'thread/realtime/item/completed',
  params: { threadId: 'native', item: { id, role, text, type: 'transcriptSegment', realtimeSessionId: 'rtc' } },
});
const opts = { skip: REDIS_SKIP, timeout: 30_000 };

test('what the Host wrote for a typed send is what the production store reads back', opts, async () => {
  await withRedisStore(async (store) => {
    await persistLiveUserText(store, scope, '打字', 'client-1');
    const [row] = await store.getByThread(scope.threadId, 10, scope.userId);
    assert.deepEqual(row?.extra?.liveCompanion, {
      callId: scope.callId,
      modality: 'typed',
      role: 'user',
      clientMessageId: 'client-1',
    });
  });
});

test('what the Host wrote for speech keeps its explicit role on read-back, for both directions', opts, async () => {
  await withRedisStore(async (store) => {
    await persistLiveTranscriptItem(store, binding, speech('u1', 'user', '我说'));
    await persistLiveTranscriptItem(store, binding, speech('a1', 'assistant', '猫答'));
    const rows = await store.getByThread(scope.threadId, 10, scope.userId);
    assert.deepEqual(
      rows.map((r) => r.extra?.liveCompanion && 'role' in r.extra.liveCompanion && r.extra.liveCompanion.role),
      ['user', 'assistant'],
    );
  });
});

test('the projection over Redis rows equals the projection over in-memory rows', opts, async () => {
  const drive = async (store: Parameters<typeof persistLiveUserText>[0]) => {
    await persistLiveTranscriptItem(store, binding, speech('u1', 'user', '你好'));
    await persistLiveUserText(store, scope, '同一句', 'client-a');
    await persistLiveUserText(store, scope, '同一句', 'client-b');
    await persistLiveTranscriptItem(store, binding, speech('a1', 'assistant', '我在'));
  };
  const shape = (p: ReturnType<typeof projectLiveTranscript>) => ({
    hasMore: p.hasMore,
    messages: p.messages.map((m) => ({ role: m.role, text: m.text, source: m.source, truncated: m.truncated })),
  });
  const memory = new MessageStore();
  await drive(memory);
  const expected = shape(projectLiveTranscript(memory.getByThread(scope.threadId, 256, scope.userId), scope));
  assert.equal(expected.messages.length, 4);
  await withRedisStore(async (store) => {
    await drive(store);
    assert.deepEqual(
      shape(projectLiveTranscript(await store.getByThread(scope.threadId, 256, scope.userId), scope)),
      expected,
    );
  });
});

test(
  'rapid appends keep insertion order on the production store, and nothing the harness wrote carries a TTL',
  opts,
  async () => {
    await withRedisStore(async (store, redis, prefix) => {
      for (let i = 0; i < 40; i++) await persistLiveUserText(store, scope, `第 ${i} 句`, `client-${i}`);
      const rows = await store.getByThread(scope.threadId, 256, scope.userId);
      assert.deepEqual(
        rows.map((r) => r.content),
        Array.from({ length: 40 }, (_, i) => `第 ${i} 句`),
      );
      // Iron rule 5: user-visible durable data has no TTL. Scan only this run's own prefix.
      let cursor = '0';
      let seen = 0;
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
        cursor = next;
        for (const key of keys) {
          const bare = key.startsWith(prefix) ? key.slice(prefix.length) : key;
          assert.equal(await redis.ttl(bare), -1, `${bare} must not expire`);
          seen++;
        }
      } while (cursor !== '0');
      assert.ok(seen >= 40, `expected the harness keys to be visible, saw ${seen}`);
    });
  },
);
