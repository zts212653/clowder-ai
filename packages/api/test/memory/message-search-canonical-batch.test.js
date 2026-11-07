import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RedisMessageStore } from '../../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { RedisThreadStore } from '../../dist/domains/cats/services/stores/redis/RedisThreadStore.js';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';
import { MessageQueryQualifier } from '../../dist/domains/memory/message-query-qualifier.js';

const principal = { userId: 'owner', viewer: { type: 'cat', catId: 'codex61-sol' } };

// Actual store hydration, deterministic transport only; never opens a Redis connection.
function fixture(t, count = 2000) {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const hashes = new Map();
  const participants = new Map();
  const candidates = Array.from({ length: count }, (_, i) => {
    const threadId = `t-${i % 7}`,
      messageId = `m-${i}`;
    const content = `Complete original unrelated body ${i} ${'正文'.repeat(50)}`;
    hashes.set(`thread:${threadId}`, {
      id: threadId,
      createdBy: 'owner',
      title: threadId,
      createdAt: '1',
      lastActiveAt: '1',
    });
    participants.set(`thread:${threadId}:participants`, ['codex61-sol']);
    hashes.set(`msg:${messageId}`, {
      id: messageId,
      threadId,
      userId: 'owner',
      content,
      timestamp: String(now + i),
      from: JSON.stringify({ kind: 'user', userId: 'owner' }),
    });
    return {
      threadId,
      messageId,
      content,
      docAnchor: `thread-${threadId}`,
      passageId: `msg-${messageId}`,
      match: 'semantic',
    };
  });
  let pending = [],
    scheduled = false,
    roundTrips = 0;
  const requests = [];
  const read = (ops) =>
    new Promise((resolve) => {
      requests.push(ops);
      pending.push(() =>
        resolve(
          ops.map(([kind, key]) => [null, kind === 'hash' ? (hashes.get(key) ?? {}) : (participants.get(key) ?? [])]),
        ),
      );
      if (scheduled) return;
      scheduled = true;
      setImmediate(() => {
        const batch = pending;
        pending = [];
        scheduled = false;
        now += 5;
        roundTrips++;
        for (const finish of batch.reverse()) finish();
      });
    });
  const redis = {
    options: {},
    hgetall: async (key) => (await read([['hash', key]]))[0][1],
    smembers: async (key) => (await read([['members', key]]))[0][1],
    multi: () => {
      const ops = [];
      const pipeline = {
        hgetall(key) {
          ops.push(['hash', key]);
          return pipeline;
        },
        smembers(key) {
          ops.push(['members', key]);
          return pipeline;
        },
        exec: () => read(ops),
      };
      return pipeline;
    },
  };
  const messageStore = new RedisMessageStore(redis),
    threadStore = new RedisThreadStore(redis);
  t.mock.method(threadStore, 'list', () => Array.from(hashes.values()).filter((h) => h.createdBy));
  const calls = [],
    traces = [];
  let mutate = () => {};
  const service = new MessageSearchService({
    messageStore,
    threadStore,
    decisionIndex: { lookup: async () => ({ status: 'unavailable', facts: new Map() }) },
    evidenceStore: {
      searchMessagePassages: async () => {
        now += count === 2000 ? 9400 : 0;
        return {
          passages: candidates,
          meta: { effectiveMode: 'hybrid', degraded: false, candidateLimit: 2000, semanticCandidatesLimited: true },
        };
      },
      readMessagePassageState: () => ({ current: true }),
    },
    qualifier: new MessageQueryQualifier(async (batch) => {
      calls.push(batch);
      mutate();
      return JSON.stringify({
        requestId: batch.requestId,
        rows: batch.rows.map((row) => [row.id, 'supported', row.body]),
      });
    }),
  });
  return {
    service,
    hashes,
    candidates,
    calls,
    requests,
    redis,
    messageStore,
    threadStore,
    mutate: (fn) => {
      mutate = fn;
    },
    search: (overrides = {}) =>
      service.search(
        { query: 'reviewer paper video taste', mode: 'hybrid', sort: 'relevance', limit: 4, ...overrides },
        principal,
        { deadlineAt: now + 15000, onTrace: (trace) => traces.push(trace) },
      ),
    metrics: () => ({ elapsedMs: now - 1_800_000_000_000, roundTrips, traces }),
  };
}

test('complete canonical projection leaves qualification and final readmission inside the original 15s', async (t) => {
  const f = fixture(t);
  const response = await f.search();
  assert.equal(f.calls.length, 2);
  assert.equal(response.results.length, 4);
  assert.equal(response.meta.qualification.examined, 2000);
  const fullBodies = new Set(f.candidates.map((row) => row.content));
  for (const batch of f.calls)
    for (const row of batch.rows) {
      assert.ok(fullBodies.has(row.body));
      assert.ok(row.body.endsWith('正文'.repeat(50)));
    }
  const metrics = f.metrics();
  assert.ok(
    metrics.elapsedMs < 13000,
    JSON.stringify({ elapsedMs: metrics.elapsedMs, roundTrips: metrics.roundTrips }),
  );
  const projection = metrics.traces.find((trace) => trace.phase === 'canonical-projection');
  assert.equal(projection.canonical.waves.maxWidth, 5, 'the original literal page/witness wave cap is unchanged');
  assert.equal(projection.canonical.acceptedRows, 2000);
  assert.ok(
    f.requests.every((ops) => ops.length <= 16),
    'batching never increases the eight-source wave limit',
  );
  t.diagnostic(
    JSON.stringify({
      kind: 'controlled transport, not production latency',
      elapsedMs: metrics.elapsedMs,
      roundTrips: metrics.roundTrips,
    }),
  );
});

test('wave snapshots never survive inference into final owner, withdrawal and revision admission', async (t) => {
  const f = fixture(t, 6);
  f.mutate(() => {
    f.hashes.get('thread:t-0').createdBy = 'another-owner';
    f.hashes.get('msg:m-1').deletedAt = '1';
    f.hashes.get('msg:m-2').content = 'changed after inference';
  });
  const response = await f.search();
  assert.ok(response.results.length > 0);
  assert.ok(response.results.every((row) => !['m-0', 'm-1', 'm-2'].includes(row.messageId)));
  assert.equal(response.meta.qualification.status, 'partial');
});

test('complete batch objects exactly match individual hydrate semantics', async (t) => {
  const f = fixture(t, 2);
  Object.assign(f.hashes.get('msg:m-0'), {
    contentBlocks: JSON.stringify([{ type: 'text', text: 'full block' }]),
    extra: JSON.stringify({ rich: { blocks: [] } }),
  });
  const ids = ['m-0', 'missing', 'm-1'];
  const messages = await f.messageStore.getByIds(ids);
  for (const id of ids) assert.deepEqual(messages.get(id), await f.messageStore.getById(id));
  const threads = await f.threadStore.getMany(['t-0', 't-1']);
  for (const id of ['t-0', 't-1']) assert.deepEqual(threads.get(id), await f.threadStore.get(id));
});

test('missing/default recovery is deferred until the original message admission permits it', async (t) => {
  const f = fixture(t, 2),
    recoveries = [];
  f.hashes.delete('thread:t-0');
  f.hashes.delete('thread:t-1');
  f.hashes.get('msg:m-0').deletedAt = '1';
  t.mock.method(f.threadStore, 'list', () => ['t-0', 't-1'].map((id) => ({ id, createdBy: 'owner' })));
  t.mock.method(f.threadStore, 'get', async (id) => {
    recoveries.push(id);
    return { id, createdBy: 'owner', participants: ['codex61-sol'] };
  });
  const response = await f.search();
  assert.deepEqual(
    response.results.map((row) => row.messageId),
    ['m-1'],
  );
  assert.deepEqual(recoveries, ['t-1', 't-1'], 'withdrawn message never causes thread recovery; return still rereads');
  recoveries.length = 0;
  await f.threadStore.getMany(['t-0', 't-1']);
  assert.deepEqual(recoveries, ['t-0', 't-1'], 'ordinary getMany retains get recovery semantics');
});

test('unknown batch transport replies fail before missing-thread recovery', async (t) => {
  const f = fixture(t, 2);
  let recoveries = 0;
  t.mock.method(f.threadStore, 'get', async () => {
    recoveries++;
    return null;
  });
  for (const replies of [null, [], [[null, null]], [[new Error('transport unavailable'), {}]], [[null, []]]]) {
    t.mock.method(f.redis, 'multi', () => {
      const pipeline = { hgetall: () => pipeline, smembers: () => pipeline, exec: async () => replies };
      return pipeline;
    });
    await assert.rejects(f.messageStore.getByIds(['m-0']));
    await assert.rejects(f.threadStore.getMany(['t-0']));
  }
  assert.equal(recoveries, 0);
});

test('batch hydration preserves literal page+witness bounds and original admitted ordering', async (t) => {
  for (const sort of ['relevance', 'time']) {
    const responses = [];
    for (const batching of [false, true]) {
      const f = fixture(t, 24);
      for (const candidate of f.candidates) {
        candidate.content = `piano full original ${candidate.messageId}`;
        f.hashes.get(`msg:${candidate.messageId}`).content = candidate.content;
      }
      // Invalid index body followed by a valid duplicate in the same wave;
      // withdrawn/foreign/stale sources must never consume the page budget.
      f.candidates[0].content = 'stale indexed piano';
      f.candidates[2] = { ...f.candidates[0], content: f.hashes.get('msg:m-0').content };
      f.hashes.get('msg:m-1').deletedAt = '1';
      f.hashes.get('msg:m-3').userId = 'foreign';
      if (!batching) {
        f.messageStore.getByIds = undefined;
        f.threadStore.getMany = undefined;
      }
      const response = await f.search({ query: 'piano', sort, limit: 3 });
      responses.push({ results: response.results, meta: response.meta });
      assert.equal(f.calls.length, 0, 'literal support never calls a model');
      assert.deepEqual(
        response.results.map((row) => row.messageId),
        ['m-0', 'm-4', 'm-5'],
      );
      assert.equal(response.meta.hasMore, true);
      if (sort === 'relevance') {
        const readIds = f.requests
          .flat()
          .filter(([kind, key]) => kind === 'hash' && key.startsWith('msg:'))
          .map(([, key]) => key);
        assert.ok(
          readIds.every((id) => Number(id.slice(6)) <= 6),
          'never reads beyond the actual literal witness',
        );
      }
    }
    assert.deepEqual(responses[1], responses[0], `batch/single admission equivalence for ${sort}`);
  }
});
