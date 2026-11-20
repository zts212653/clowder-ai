import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';
import { searchMessagePassages } from '../../dist/domains/memory/message-passage-search.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

async function fixture(t, { lexicalMs = 10_000, afterLexical = () => {} } = {}) {
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  t.after(() => store.close());
  await store.upsert(
    ['visible', 'hidden'].map((id) => ({
      anchor: `thread-${id}`,
      kind: 'thread',
      status: 'active',
      title: id,
      updatedAt: '2026-11-17',
    })),
  );
  const db = store.getDb();
  const insert = db.prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES (?,?,?,?)');
  for (const [thread, id, date] of [
    ['visible', 'current', '2026-11-17T00:00:00Z'],
    ['visible', 'source', '2026-11-17T00:00:00Z'],
    ['visible', 'too-old', '2026-01-01T00:00:00Z'],
    ['hidden', 'private', '2026-11-17T00:00:00Z'],
  ])
    insert.run(`thread-${thread}`, `msg-${id}`, '守望猫补了原话出处', date);

  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  const counts = { lexical: 0, vectorStarted: 0, hybrid: 0, semantic: 0 };
  const prepare = db.prepare.bind(db);
  t.mock.method(db, 'prepare', (sql) => {
    const statement = prepare(sql);
    if (sql.includes('FROM passage_fts f CROSS JOIN evidence_passages')) counts.lexical++;
    // Real SQLite and full filters run first. Only its elapsed time is controlled;
    // this test neither sleeps nor constructs a large corpus to manufacture slowness.
    if (sql.includes('THEN') && sql.includes('message_cjk_match')) {
      const all = statement.all.bind(statement);
      t.mock.method(statement, 'all', (...args) => {
        const rows = all(...args);
        elapsed += lexicalMs;
        t.mock.timers.tick(lexicalMs);
        afterLexical(db);
        return rows;
      });
    }
    return statement;
  });
  return {
    store,
    counts,
    options: {
      visibleThreadIds: ['visible'],
      mode: 'hybrid',
      candidateOrder: 'relevance',
      deadlineAt: 16_000,
      dateFrom: '2026-11-01T00:00:00Z',
      excludeSource: { threadId: 'visible', messageId: 'source' },
    },
    deps: {
      db,
      isEmbeddingAvailable: async () => true,
      vectorStarted() {
        counts.vectorStarted++;
      },
      async hybridSearch(lexical) {
        counts.hybrid++;
        return lexical;
      },
      async semanticSearch() {
        counts.semantic++;
        return [];
      },
      reportVectorDegrade() {
        throw new Error('admission is not a vector failure');
      },
    },
  };
}

test('slow fresh lexical results skip an unaffordable optional vector stage and keep exact filters', async (t) => {
  const f = await fixture(t);
  const result = await searchMessagePassages('守望猫', f.options, f.deps);
  assert.equal(f.counts.vectorStarted, 0, 'do not allocate vectors that would require an unaffordable fresh replay');
  assert.equal(f.counts.hybrid, 0);
  assert.equal(f.counts.lexical, 1);
  assert.deepEqual(
    result.passages.map((p) => p.messageId),
    ['current'],
  );
  assert.equal(result.meta.effectiveMode, 'lexical');
  assert.equal(result.meta.degraded, true);
  assert.equal(result.meta.degradeReason, 'passage_vector_admission_budget_insufficient');
  assert.equal(result.meta.semanticCandidatesLimited, false, 'no semantic candidates were read');
});

test('a slow default hybrid search makes the same admission decision', async (t) => {
  const f = await fixture(t);
  const { mode: _mode, ...options } = f.options;
  const result = await searchMessagePassages('守望猫', options, f.deps);
  assert.equal(f.counts.vectorStarted, 0);
  assert.equal(result.meta.degradeReason, 'passage_vector_admission_budget_insufficient');
});

for (const outcome of ['remaining-insufficient', 'deadline-elapsed', 'caller-aborted'])
  test(`availability time is included before vector admission: ${outcome}`, async (t) => {
    const f = await fixture(t, { lexicalMs: 1000 });
    const controller = new AbortController();
    const abort = new DOMException('caller cancelled during availability', 'AbortError');
    f.deps.isEmbeddingAvailable = async () => {
      t.mock.timers.tick(outcome === 'deadline-elapsed' ? 8000 : 4000);
      if (outcome === 'caller-aborted') controller.abort(abort);
      return true;
    };
    const reading = searchMessagePassages(
      '守望猫',
      { ...f.options, deadlineAt: 9500, signal: controller.signal },
      f.deps,
    );
    if (outcome === 'remaining-insufficient') {
      const result = await reading;
      assert.equal(result.meta.degradeReason, 'passage_vector_admission_budget_insufficient');
      assert.deepEqual(
        result.passages.map((p) => p.messageId),
        ['current'],
      );
    } else {
      await assert.rejects(
        reading,
        outcome === 'caller-aborted' ? (error) => error === abort : { name: 'TimeoutError' },
      );
    }
    assert.equal(f.counts.vectorStarted, 0);
    assert.equal(f.counts.hybrid, 0);
  });

test('a short repeat execution window does not replace the original request admission budget', async (t) => {
  const f = await fixture(t, { lexicalMs: 100 });
  const result = await searchMessagePassages(
    '守望猫',
    { ...f.options, deadlineAt: 2000, requestDeadlineAt: 16_000 },
    f.deps,
  );
  assert.equal(f.counts.vectorStarted, 1);
  assert.equal(f.counts.hybrid, 1);
  assert.equal(result.meta.degraded, false);
});

for (const [name, overrides, lexicalMs, vectors] of [
  ['fast hybrid', {}, 100, 1],
  ['explicit lexical', { mode: 'lexical' }, 10_000, 0],
  ['explicit semantic', { mode: 'semantic' }, 10_000, 1],
  ['no deadline', { deadlineAt: undefined }, 10_000, 1],
  ['nonfinite deadline', { deadlineAt: Infinity }, 10_000, 1],
])
  test(`${name} retains its existing vector behavior`, async (t) => {
    const f = await fixture(t, { lexicalMs });
    const result = await searchMessagePassages('守望猫', { ...f.options, ...overrides }, f.deps);
    assert.equal(f.counts.vectorStarted, vectors);
    assert.equal(result.meta.degraded, false);
    assert.notEqual(result.meta.degradeReason, 'passage_vector_admission_budget_insufficient');
  });

test('budget admission does not revive a candidate withdrawn after the lexical read', async (t) => {
  const f = await fixture(t, {
    afterLexical(db) {
      db.prepare("DELETE FROM evidence_passages WHERE passage_id='msg-current'").run();
    },
  });
  const result = await searchMessagePassages('守望猫', f.options, f.deps);
  assert.equal(f.counts.vectorStarted, 0);
  assert.deepEqual(result.passages, []);
});

test('a caller abort after lexical completion still wins over budget admission', async (t) => {
  const controller = new AbortController();
  const reason = new DOMException('caller disconnected', 'AbortError');
  const f = await fixture(t, {
    afterLexical() {
      controller.abort(reason);
    },
  });
  await assert.rejects(
    searchMessagePassages('守望猫', { ...f.options, signal: controller.signal }, f.deps),
    (error) => error === reason,
  );
  assert.equal(f.counts.vectorStarted, 0);
});

test('an expired absolute deadline is not converted into a successful lexical fallback', async (t) => {
  const f = await fixture(t, { lexicalMs: 15_000 });
  await assert.rejects(searchMessagePassages('守望猫', f.options, f.deps), { name: 'TimeoutError' });
  assert.equal(f.counts.vectorStarted, 0);
});

test('the real service admits the current lexical source and discloses the skipped semantic stage', async (t) => {
  const f = await fixture(t);
  const thread = { id: 'visible', createdBy: 'owner', title: 'Visible' };
  const service = new MessageSearchService({
    threadStore: { get: () => thread, list: () => [thread] },
    messageStore: {
      getById: (id) =>
        id === 'current'
          ? {
              id,
              threadId: 'visible',
              userId: 'owner',
              content: '守望猫补了原话出处',
              timestamp: Date.parse('2026-11-17T00:00:00Z'),
            }
          : null,
    },
    evidenceStore: {
      searchMessagePassages: (query, options) => searchMessagePassages(query, options, f.deps),
      readMessagePassageState: (candidate) => f.store.readMessagePassageState(candidate),
    },
  });
  const result = await service.search(
    { query: '守望猫', limit: 5, mode: 'hybrid', dateFrom: '2026-11-01' },
    { userId: 'owner', viewer: { type: 'user' } },
  );
  assert.deepEqual(
    result.results.map((row) => row.messageId),
    ['current'],
  );
  assert.equal(result.meta.degradeReason, 'passage_vector_admission_budget_insufficient');
  assert.equal(f.counts.lexical, 1);
  assert.equal(f.counts.vectorStarted, 0);
  assert.ok(Date.now() < 16_000, 'the original absolute deadline still has canonical admission time');
});
