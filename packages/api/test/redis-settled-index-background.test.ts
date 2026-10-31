import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type TestContext, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { advanceSettledIndex, type SettledIndexSource } from '../src/utils/redis-settled-index.js';
import { continueSettledIndex } from '../src/utils/settled-index-worker.js';
import { cleanupClientKeyspace } from './helpers/redis-test-helpers.js';

async function fixture(t: TestContext) {
  assert.equal(process.env.CAT_CAFE_REDIS_TEST_ISOLATED, '1', 'use the canonical isolated Redis runner');
  const config = { url: process.env.REDIS_URL, keyPrefix: `history-background:${randomUUID()}:` };
  const redis = createRedisClient(config);
  await redis.ping();
  t.after(async () => {
    redis.disconnect();
    const cleanup = createRedisClient(config);
    await cleanup.ping();
    await cleanupClientKeyspace(cleanup);
    await cleanup.quit();
  });
  await redis.hset('detail:legacy', { id: 'legacy', status: 'answered', closedAt: '42' });
  const source: SettledIndexSource = {
    progressKey: 'history-progress',
    prefix: 'detail:',
    type: 'hash',
    entry: (raw: unknown) => {
      const record = raw as Record<string, string>;
      return { indexKey: 'owner:settled', id: record.id, score: Number(record.closedAt) };
    },
  };
  return { redis, source };
}

async function eventually(condition: () => Promise<boolean> | boolean, message: string) {
  const deadline = performance.now() + 2_000;
  while (!(await condition()) && performance.now() < deadline) await delay(20);
  assert.equal(await condition(), true, message);
}

test('one history read finishes sparse legacy preparation after the page stops requesting', async (t) => {
  const { redis, source } = await fixture(t);
  const original = await redis.hgetall('detail:legacy');
  const scan = redis.scan.bind(redis);
  let scanCalls = 0;
  redis.scan = async (...args: Parameters<typeof redis.scan>) => {
    // Redis MATCH may produce many empty pages while traversing unrelated keys.
    if (++scanCalls <= 4) return [String(scanCalls), []];
    return scan('0', ...args.slice(1));
  };
  assert.equal(await advanceSettledIndex(redis, source), false, 'the first bounded request must remain preparing');
  await eventually(
    async () => JSON.parse((await redis.get('history-progress')) ?? '{}').complete === true,
    'the original history read must finish without another history request',
  );
  assert.ok(scanCalls >= 5);
  assert.deepEqual(await redis.zrange('owner:settled', 0, -1), ['legacy']);
  assert.deepEqual(await redis.hgetall('detail:legacy'), original);
  assert.equal(await redis.pttl('detail:legacy'), -1);
  const scans = scanCalls;
  assert.equal(await advanceSettledIndex(redis, source), true);
  await delay(60);
  assert.equal(scanCalls, scans, 'completed history never resumes SCAN');
});

test('oversized SCAN pages still drain at most 200 details per batch and preserve source records', async (t) => {
  const { redis, source } = await fixture(t);
  const writes = redis.pipeline();
  for (let i = 0; i < 600; i++) writes.hset(`detail:${i}`, { id: `id-${i}`, status: 'answered', closedAt: String(i) });
  await writes.exec();
  const keys = ['detail:legacy', ...Array.from({ length: 600 }, (_, i) => `detail:${i}`)];
  const pipeline = redis.pipeline.bind(redis);
  const batches: number[] = [];
  redis.pipeline = () => {
    const p = pipeline();
    const hgetall = p.hgetall.bind(p);
    let count = 0;
    p.hgetall = (...args: Parameters<typeof p.hgetall>) => {
      count++;
      return hgetall(...args);
    };
    const exec = p.exec.bind(p);
    p.exec = async () => {
      batches.push(count);
      return exec();
    };
    return p;
  };
  let scans = 0;
  redis.scan = async () => {
    scans++;
    return ['0', keys.map((key) => configKey(redis, key))];
  };
  assert.equal(await advanceSettledIndex(redis, source), false);
  await eventually(
    async () => JSON.parse((await redis.get(source.progressKey)) ?? '{}').complete === true,
    'backlog drains',
  );
  assert.equal(scans, 1, 'pending keys drain before another scan');
  assert.deepEqual(batches, [200, 200, 200, 1]);
  assert.equal(await redis.zcard('owner:settled'), 601);
  assert.equal(await redis.pttl('detail:599'), -1);
});

function configKey(redis: ReturnType<typeof createRedisClient>, key: string) {
  return `${redis.options.keyPrefix ?? ''}${key}`;
}

test('background sources share one fair serial worker and duplicate scheduling does not multiply jobs', async (t) => {
  const { redis } = await fixture(t);
  const calls: string[] = [],
    rounds = new Map<string, number>();
  let active = 0,
    maximum = 0;
  for (const id of ['F128', 'F193', 'F225', 'F276', 'F306']) {
    const step = async () => {
      calls.push(id);
      active++;
      maximum = Math.max(maximum, active);
      await delay(4);
      active--;
      const count = (rounds.get(id) ?? 0) + 1;
      rounds.set(id, count);
      return { complete: count === 3, batches: count, detailReads: 0, pendingKeys: 0 };
    };
    for (let i = 0; i < 10; i++) continueSettledIndex(redis, id, step);
  }
  await eventually(() => calls.length === 15 && active === 0, 'all five sources complete');
  assert.equal(maximum, 1);
  assert.deepEqual(calls, Array(3).fill(['F128', 'F193', 'F225', 'F276', 'F306']).flat());
  await delay(60);
  assert.equal(calls.length, 15);
  assert.equal(redis.listenerCount('end'), 0, 'completed worker detaches lifecycle listeners');
});

test('closing Redis stops future batches and a new client resumes persisted progress', async (t) => {
  const { redis, source } = await fixture(t);
  let scans = 0;
  redis.scan = async () => {
    scans++;
    return ['42', []];
  };
  assert.equal(await advanceSettledIndex(redis, source), false);
  redis.disconnect();
  await delay(100);
  assert.equal(scans, 1);
  const replacement = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: redis.options.keyPrefix });
  t.after(() => replacement.disconnect());
  await replacement.ping();
  assert.equal(JSON.parse((await replacement.get(source.progressKey)) ?? '{}').cursor, '42');
  replacement.scan = async () => ['0', [configKey(replacement, 'detail:legacy')]];
  assert.equal(await advanceSettledIndex(replacement, source), true);
  assert.deepEqual(await replacement.zrange('owner:settled', 0, -1), ['legacy']);
});

test('a failing background read stops retrying and never marks missing history complete', async (t) => {
  const { redis, source } = await fixture(t);
  let scans = 0,
    broken = true;
  redis.scan = async () => (++scans === 1 ? ['42', []] : ['0', [configKey(redis, 'detail:legacy')]]);
  const entry = source.entry;
  source.entry = (raw) => {
    if (broken) throw new SyntaxError('private record sentinel');
    return entry(raw);
  };
  assert.equal(await advanceSettledIndex(redis, source), false);
  await eventually(() => scans === 2, 'background read attempted once');
  await delay(100);
  assert.equal(scans, 2, 'faults do not enter a retry loop');
  assert.equal(JSON.parse((await redis.get(source.progressKey)) ?? '{}').complete, false);
  assert.equal(await redis.zcard('owner:settled'), 0);
  broken = false;
  assert.equal(await advanceSettledIndex(redis, source), true, 'a new explicit read can retry after repair');
});

test('a fresh history read during a failing batch survives that failure and uses the latest source', async (t) => {
  const { redis, source } = await fixture(t);
  const original = await redis.hgetall('detail:legacy');
  let scans = 0;
  redis.scan = async () => (++scans === 1 ? ['42', []] : ['0', [configKey(redis, 'detail:legacy')]]);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(release);
  assert.equal(
    await advanceSettledIndex(redis, {
      ...source,
      entry: async () => {
        entered();
        await barrier;
        throw new SyntaxError('private failing batch sentinel');
      },
    }),
    false,
  );
  await ready;
  try {
    const checkpoint = JSON.parse((await redis.get(source.progressKey)) ?? '{}');
    assert.equal(checkpoint.cursor, '42');
    assert.equal(checkpoint.batches, 1);
    assert.equal(await advanceSettledIndex(redis, source), false, 'the explicit read contends with the old batch lock');
  } finally {
    release();
  }
  await eventually(
    async () => JSON.parse((await redis.get(source.progressKey)) ?? '{}').complete === true,
    'the explicit read during failure must resume preparation without a third history read',
  );
  assert.deepEqual(await redis.zrange('owner:settled', 0, -1), ['legacy']);
  assert.deepEqual(await redis.hgetall('detail:legacy'), original);
  assert.equal(await redis.pttl('detail:legacy'), -1);
  await delay(60);
  assert.equal(scans, 3, 'one explicit retry completes and leaves no recurring job');
  assert.equal(redis.listenerCount('end'), 0);
});

test('source deletion during backfill cannot reconstruct a stale terminal index entry', async (t) => {
  const { redis, source } = await fixture(t);
  let scans = 0;
  redis.scan = async () => (++scans === 1 ? ['42', []] : ['0', [configKey(redis, 'detail:legacy')]]);
  const entry = source.entry;
  source.entry = async (raw) => {
    await redis.del('detail:legacy');
    return entry(raw);
  };
  assert.equal(await advanceSettledIndex(redis, source), false);
  await eventually(
    async () => JSON.parse((await redis.get(source.progressKey)) ?? '{}').complete === true,
    'migration completes',
  );
  assert.equal(await redis.exists('detail:legacy'), 0);
  assert.equal(await redis.zcard('owner:settled'), 0, 'Lua source comparison rejects the stale entry');
});

test('actual unrelated Redis keys do not require the user to keep reading history', async (t) => {
  const { redis, source } = await fixture(t);
  for (let start = 0; start < 20_000; start += 500) {
    const writes = redis.pipeline();
    for (let i = start; i < start + 500; i++) writes.set(`unrelated:${i}`, 'not an approval');
    await writes.exec();
  }
  const progress = await advanceSettledIndex(redis, source);
  assert.equal(progress, false, 'a sparse full-keyspace scan cannot complete in one bounded request');
  await eventually(
    async () => JSON.parse((await redis.get(source.progressKey)) ?? '{}').complete === true,
    'sparse Redis completes in background',
  );
  const checkpoint = JSON.parse((await redis.get(source.progressKey)) ?? '{}');
  assert.ok(checkpoint.batches > 1);
  assert.equal(checkpoint.detailReads, 1);
  assert.equal(await redis.zscore('owner:settled', 'legacy'), '42');
});

test('an expired batch lease cannot overwrite a second client committed progress or duplicate its counters', async (t) => {
  const { redis, source } = await fixture(t);
  const other = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: redis.options.keyPrefix });
  t.after(() => other.disconnect());
  await other.ping();
  redis.scan = other.scan = async () => ['0', [configKey(redis, 'detail:legacy')]];
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = advanceSettledIndex(redis, {
    ...source,
    entry: async (raw) => {
      entered();
      await barrier;
      return source.entry(raw, 'detail:legacy');
    },
  });
  await ready;
  await other.del(`${source.progressKey}:lock`); // Model expiry of this fixture's first batch lease.
  assert.equal(await advanceSettledIndex(other, source), true);
  release();
  assert.equal(await first, false, 'a lost lease never reports its own batch committed');
  await delay(60);
  const committed = JSON.parse((await redis.get(source.progressKey)) ?? '{}');
  assert.equal(committed.batches, 1);
  assert.equal(committed.detailReads, 1);
  assert.equal(committed.complete, true);
  assert.deepEqual(await redis.zrange('owner:settled', 0, -1), ['legacy']);
});
