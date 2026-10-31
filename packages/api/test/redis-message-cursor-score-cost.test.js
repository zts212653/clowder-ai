import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';

function fixture({ deliveredTop = false, foreignOnly = false } = {}) {
  const rows = Array.from({ length: 130 }, (_, i) => {
    const score = i < 60 ? 100 : i < 120 ? 90 : 80;
    const queued = (i < 60 && !deliveredTop) || i === 117;
    const id = `m${String(i).padStart(3, '0')}`;
    return {
      id,
      score,
      hash: {
        id,
        threadId: 'cursor-score-fixture',
        userId: foreignOnly || i === 119 ? 'foreign' : 'owner',
        catId: 'codex61-sol',
        from: JSON.stringify({ kind: 'agent', catId: 'codex61-sol' }),
        content: `full body ${id}`,
        mentions: '[]',
        timestamp: String(queued ? score : score - 5),
        ...(queued ? {} : { deliveredAt: String(score) }),
        deliveryStatus: queued ? 'queued' : 'delivered',
        ...(i === 118 ? { deletedAt: '200' } : {}),
      },
    };
  }).sort((a, b) => b.score - a.score || b.id.localeCompare(a.id));
  const scoreCalls = [];
  const rangeCalls = [];
  const redis = {
    options: {},
    async zrevrangebyscore(_key, max, _min, ...args) {
      rangeCalls.push(args);
      const exclusive = String(max).startsWith('(');
      const upper = Number(exclusive ? String(max).slice(1) : max);
      const candidates = rows.filter((row) => (exclusive ? row.score < upper : row.score <= upper));
      const limit = args.indexOf('LIMIT');
      const selected = candidates.slice(Number(args[limit + 1]), Number(args[limit + 1]) + Number(args[limit + 2]));
      return args.includes('WITHSCORES')
        ? selected.flatMap((row) => [row.id, String(row.score)])
        : selected.map((row) => row.id);
    },
    async zscore(_key, id) {
      scoreCalls.push(id);
      return String(rows.find((row) => row.id === id).score);
    },
    multi() {
      const ids = [];
      const pipeline = {
        hgetall(key) {
          ids.push(key.slice(key.lastIndexOf(':') + 1));
          return pipeline;
        },
        async exec() {
          return ids.map((id) => [null, rows.find((row) => row.id === id).hash]);
        },
      };
      return pipeline;
    },
  };
  return { store: new RedisMessageStore(redis), scoreCalls, rangeCalls };
}

function noPerCandidateScoreReads(f, expectedRanges) {
  assert.equal(f.scoreCalls.length, 0, 'cursor reads must not issue one ZSCORE per candidate');
  assert.equal(f.rangeCalls.length, expectedRanges, 'range exhaustion counts members, not alternating array fields');
  assert.ok(f.rangeCalls.every((args) => args.includes('WITHSCORES')));
}

test('legacy cursor filters hidden/foreign rows across chunks without per-ID Redis score round trips', async () => {
  const f = fixture();
  const page = await f.store.getByThreadBefore('cursor-score-fixture', 100, 3, 'm030', 'owner');
  assert.deepEqual(
    page.map((message) => message.id),
    ['m114', 'm115', 'm116'],
  );
  assert.equal(page[2].content, 'full body m116');
  assert.equal(page[2].timestamp, 85);
  assert.equal(page[2].deliveredAt, 90);
  noPerCandidateScoreReads(f, 2);
});

test('artifact queued-message mode retains exact same-score ID boundary and oldest-first order', async () => {
  const f = fixture();
  const page = await f.store.getByThreadBefore('cursor-score-fixture', 100, 3, 'm030', 'owner', {
    includeQueuedCatMessages: true,
  });
  assert.deepEqual(
    page.map((message) => message.id),
    ['m027', 'm028', 'm029'],
  );
  assert.ok(page.every((message) => message.deliveryStatus === 'queued'));
  noPerCandidateScoreReads(f, 1);
});

test('cursor equality uses sorted-set score rather than original message timestamp', async () => {
  const f = fixture({ deliveredTop: true });
  const page = await f.store.getByThreadBefore('cursor-score-fixture', 100, 3, 'm030', 'owner');
  assert.deepEqual(
    page.map((message) => message.id),
    ['m027', 'm028', 'm029'],
  );
  assert.ok(page.every((message) => message.timestamp === 95 && message.deliveredAt === 100));
  noPerCandidateScoreReads(f, 1);
});

test('short final range exhausts filtered history without an extra range or score lookup', async () => {
  const f = fixture({ foreignOnly: true });
  const page = await f.store.getByThreadBefore('cursor-score-fixture', 100, 3, 'm030', 'owner');
  assert.deepEqual(page, []);
  noPerCandidateScoreReads(f, 3);
});
