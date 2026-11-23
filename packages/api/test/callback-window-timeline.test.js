import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { readCallbackMessageWindow } from '../dist/routes/callback-visible-history.js';
import { pageThreadContextEnvelope } from '../dist/routes/thread-context-envelope.js';

// Exercise the real Redis store against a legacy sorted-set score. The index
// keeps the original authoring position; hydration contains a later delivery.
function fixture({ foreignCount = 0 } = {}) {
  const seeds = [
    ['older', 90, 90],
    ['anchor', 100, 200],
    ['later', 150, 150],
    ...Array.from({ length: foreignCount }, (_, i) => [`foreign-${i}`, 95 + i / 100, 95 + i / 100]),
  ];
  const rows = seeds
    .map(([id, score, deliveredAt]) => ({
      id,
      score,
      hash: {
        id,
        userId: id.startsWith('foreign') ? 'foreign' : 'owner',
        threadId: 'thread',
        from: JSON.stringify(
          id.startsWith('foreign')
            ? { kind: 'agent', catId: 'codex61-sol' }
            : { kind: 'system', service: 'watcher-panel' },
        ),
        content: id,
        mentions: '[]',
        timestamp: String(score),
        deliveredAt: String(deliveredAt),
        deliveryStatus: 'delivered',
      },
    }))
    .sort((a, b) => b.score - a.score || b.id.localeCompare(a.id));
  const redis = {
    options: {},
    async zrevrank(_key, id) {
      const index = rows.findIndex((row) => row.id === id);
      return index < 0 ? null : index;
    },
    async zrevrange(_key, start, end, ...args) {
      const selected = rows.slice(start, end + 1);
      return args.includes('WITHSCORES')
        ? selected.flatMap((row) => [row.id, String(row.score)])
        : selected.map((row) => row.id);
    },
    async zrevrangebyscore(_key, max, _min, ...args) {
      const exclusive = String(max).startsWith('(');
      const upper = Number(exclusive ? String(max).slice(1) : max),
        limit = args.indexOf('LIMIT');
      const selected = rows
        .filter((row) => (exclusive ? row.score < upper : row.score <= upper))
        .slice(Number(args[limit + 1]), Number(args[limit + 1]) + Number(args[limit + 2]));
      return args.includes('WITHSCORES')
        ? selected.flatMap((row) => [row.id, String(row.score)])
        : selected.map((row) => row.id);
    },
    multi() {
      const ids = [];
      const pipeline = {
        hgetall(key) {
          ids.push(key.slice(key.lastIndexOf(':') + 1));
          return pipeline;
        },
        async exec() {
          return ids.map((id) => [null, rows.find((row) => row.id === id)?.hash ?? {}]);
        },
      };
      return pipeline;
    },
  };
  return {
    store: new RedisMessageStore(redis),
    anchor: { id: 'anchor', timestamp: 100, deliveredAt: 200, userId: 'owner', threadId: 'thread' },
  };
}

const beforeWindow = (fixture) =>
  readCallbackMessageWindow({
    ...fixture,
    threadId: 'thread',
    userId: 'owner',
    direction: 'before',
    count: 25,
    include: () => true,
  });

test('before window excludes its anchor and later index rows when historical score precedes deliveredAt', async () => {
  const before = await beforeWindow(fixture());
  assert.deepEqual(
    before.map((message) => message.id),
    ['older'],
  );
});

test('a recovered window has unique IDs and its envelope can reach the terminal page', async () => {
  const f = fixture(),
    before = await beforeWindow(f);
  const page = pageThreadContextEnvelope({
    base: { threadId: 'thread', contextScope: 'recent_history' },
    scopeHash: 'legacy-window',
    selection: { kind: 'history' },
    allCandidates: [...before, f.anchor].map((message) => ({
      id: message.id,
      source: 'published',
      originalChars: message.id.length,
      projection: { id: message.id, content: message.id },
      oversizedProjection: { id: message.id },
    })),
  });
  assert.deepEqual(
    page.payload.messages.map((message) => message.id),
    ['older', 'anchor'],
  );
  assert.equal(page.payload.hasMore, false);
  assert.equal(page.payload.nextCursor, undefined);
});

test('raw cursor crosses an empty owner-visible batch without discarding older history', async () => {
  const before = await beforeWindow(fixture({ foreignCount: 60 }));
  assert.deepEqual(
    before.map((message) => message.id),
    ['older'],
  );
});
