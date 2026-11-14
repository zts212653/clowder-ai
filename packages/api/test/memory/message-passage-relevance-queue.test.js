import assert from 'node:assert/strict';
import { test } from 'node:test';
import { passageVectorKey } from '../../dist/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

const options = { visibleThreadIds: ['visible'], mode: 'hybrid', candidateOrder: 'relevance' };
const ids = (result) => result.passages.map((row) => row.messageId);

async function fixture(t, rows, nn = []) {
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  t.after(() => store.close());
  await store.upsert(
    ['visible', 'private'].map((id) => ({
      anchor: `thread-${id}`,
      kind: 'thread',
      title: 'Controlled message sources',
      status: 'active',
      updatedAt: '2026-11-01',
    })),
  );
  const insert = store
    .getDb()
    .prepare(
      'INSERT INTO evidence_passages (doc_anchor, passage_id, content, position, created_at) VALUES (?,?,?,?,?)',
    );
  store.getDb().transaction(() => {
    rows.forEach((row, i) => {
      insert.run(`thread-${row.thread ?? 'visible'}`, `msg-${row.id}`, row.content, i, row.date);
    });
  })();
  store.setEmbedDeps({
    mode: 'on',
    vectorStore: {},
    passageVectorStore: {
      search: (_vector, limit) =>
        nn.slice(0, limit).map((id, i) => ({
          passageKey: passageVectorKey('thread-visible', `msg-${id}`),
          distance: i / 10,
        })),
    },
    embedding: {
      isReady: () => true,
      reprobeIfNeeded: async () => {},
      getModelInfo: () => ({ modelId: 'controlled-queue', modelRev: '1', dim: 4 }),
      embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0, 0])),
    },
  });
  return store;
}

test('ordinary time and relevance share an RRF queue that keeps high NN sources beyond a full literal pool', async (t) => {
  const store = await fixture(
    t,
    [
      { id: 'original', content: '给 Cedar 取名的原始讨论，大家在这里一起决定称呼。', date: '2026-01-02' },
      ...Array.from({ length: 2010 }, (_, i) => ({
        id: `retelling-${i}`,
        content: `Cedar 取名 转述${i}。`,
        date: '2026-06-01',
      })),
      { id: 'semantic', content: '新伙伴的称呼在此敲定，留下最初的讨论。', date: '2026-01-01' },
    ],
    ['semantic', 'retelling-0'],
  );
  const legacy = await store.searchMessagePassages('Cedar 取名', {
    visibleThreadIds: ['visible'],
    mode: 'hybrid',
    sort: 'relevance',
  });
  assert.equal(ids(legacy).includes('semantic'), false, 'legacy policy remains opt-in independent');
  const relevance = await store.searchMessagePassages('Cedar 取名', { ...options, sort: 'relevance' });
  assert.equal(ids(relevance).indexOf('semantic'), 1, 'hard literal priority must not evict the high NN source');
  assert.equal(ids(relevance).includes('original'), false, 'lexical-pool omission is still a distinct limitation');
  assert.equal(relevance.passages.length, 2000, 'the reader pool is unchanged');
  const time = await store.searchMessagePassages('Cedar 取名', { ...options, sort: 'time' });
  assert.deepEqual(time, relevance, 'display order is the canonical consumer responsibility');
  assert.equal(time.meta.sort, 'relevance');
  assert.equal(time.meta.truncated, true);
  assert.equal(time.meta.effectiveMode, 'hybrid');
  assert.equal(time.meta.degraded, false);
  assert.equal(time.meta.sourceCoverage, 'unknown');
});

test('queue lexical input uses relevance rather than age, with exact-source, scope, dates and full bodies intact', async (t) => {
  const content = `Cedar 取名 ${'正文。'.repeat(100)}`;
  const store = await fixture(t, [
    { id: 'old', content: `Cedar 的取名回顾。${'其他背景。'.repeat(100)}`, date: '2026-08-01' },
    { id: 'source', content, date: '2026-09-20' },
    { id: 'duplicate', content, date: '2026-09-21' },
    { id: 'current', content, date: '2026-09-22' },
    { id: 'future', content, date: '2026-10-01' },
    { id: 'secret', content, date: '2026-09-01', thread: 'private' },
  ]);
  const legacy = await store.searchMessagePassages('Cedar 取名', {
    visibleThreadIds: ['visible'],
    mode: 'lexical',
    sort: 'time',
    candidateLimit: 1,
  });
  assert.deepEqual(ids(legacy), ['old']);
  const queue = await store.searchMessagePassages('Cedar 取名', {
    ...options,
    mode: 'lexical',
    sort: 'time',
    candidateLimit: 1,
  });
  assert.notDeepEqual(ids(queue), ['old'], 'an older lexical position is not its relevance rank');
  assert.equal(queue.passages.length, 1);
  assert.equal(queue.passages[0].content, content, 'reader candidates keep the complete body beyond snippet budgets');
  assert.equal(queue.meta.sort, 'relevance');
  const filtered = {
    ...options,
    mode: 'lexical',
    sort: 'time',
    threadId: 'visible',
    dateFrom: '2026-09-01',
    dateTo: '2026-09-30',
    excludeSource: { threadId: 'visible', messageId: 'current' },
  };
  const result = await store.searchMessagePassages('Cedar 取名', filtered);
  assert.deepEqual(new Set(ids(result)), new Set(['source', 'duplicate']));
  assert.ok(result.passages.every((p) => p.threadId === 'visible' && p.content === content));
  assert.deepEqual(result, await store.searchMessagePassages('Cedar 取名', { ...filtered, sort: 'relevance' }));
});

test('queue mode keeps vector downgrade honest and rejects cancellation', async (t) => {
  const store = await fixture(t, [{ id: 'source', content: 'Cedar 取名', date: '2026-09-20' }]);
  store.setEmbedDeps({ mode: 'off' });
  const result = await store.searchMessagePassages('Cedar 取名', { ...options, sort: 'time' });
  assert.deepEqual(ids(result), ['source']);
  assert.equal(result.meta.sort, 'relevance');
  assert.equal(result.meta.effectiveMode, 'lexical');
  assert.equal(result.meta.degraded, true);
  assert.equal(result.meta.degradeReason, 'passage_embedding_unavailable');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(store.searchMessagePassages('Cedar 取名', { ...options, signal: controller.signal }), {
    name: 'AbortError',
  });
});
