import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import * as sqliteVec from 'sqlite-vec';
import { EmbeddingService } from '../../src/domains/memory/EmbeddingService.js';
import { embedPassages } from '../../src/domains/memory/embed-utils.js';
import { PassageVectorStore, passageVectorKey } from '../../src/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../../src/domains/memory/SqliteEvidenceStore.js';
import { ensurePassageVectorTable, ensureVectorTable } from '../../src/domains/memory/schema.js';
import { createSearchEmbeddingCapability } from '../../src/domains/memory/search-embedding-capability.js';
import { VectorStore } from '../../src/domains/memory/VectorStore.js';

const qwen = 'mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ';
const instruction = 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:';

async function fixture(t: TestContext, modelId: string) {
  const root = mkdtempSync(join(tmpdir(), 'query-embedding-input-'));
  const store = new SqliteEvidenceStore(join(root, 'neutral.sqlite'));
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  await store.upsert([
    { anchor: 'thread-visible', kind: 'thread', status: 'active', title: 'Neutral', updatedAt: '2026-01-01' },
    {
      anchor: 'neutral-doc',
      kind: 'feature',
      status: 'active',
      title: 'Neutral document',
      summary: 'Ibis configuration',
      updatedAt: '2026-01-01',
    },
  ]);
  const db = store.getDb();
  sqliteVec.load(db);
  ensureVectorTable(db, 4);
  ensurePassageVectorTable(db, 4);
  const passages = new PassageVectorStore(db, 4);
  const vectors = new VectorStore(db, 4);
  const model = { modelId, modelRev: '1', dim: 4 };
  vectors.initMeta(model);
  db.prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)').run(
    'thread-visible',
    'msg-source',
    'Ibis 配置的中性来源。',
    '2026-01-01',
  );
  passages.upsert(passageVectorKey('thread-visible', 'msg-source'), new Float32Array([1, 0, 0, 0]));
  vectors.upsert('neutral-doc', new Float32Array([1, 0, 0, 0]));
  const calls: string[][] = [];
  const embedding = {
    load: async () => {},
    reprobeIfNeeded: async () => {},
    isReady: () => true,
    getModelInfo: () => model,
    embed: async (texts: string[]) => {
      calls.push([...texts]);
      return texts.map(() => new Float32Array([1, 0, 0, 0]));
    },
  };
  store.setEmbedDeps({ mode: 'on', embedding, vectorStore: vectors, passageVectorStore: passages });
  return { store, passages, embedding, calls };
}

test('Qwen retrieval marks queries exactly once across actual message-worker IPC and preserves complete input', async (t) => {
  const f = await fixture(t, qwen);
  const query = 'Ibis 配置';
  for (const mode of ['semantic', 'hybrid'] as const) {
    let previous: Awaited<ReturnType<SqliteEvidenceStore['searchMessagePassages']>> | undefined;
    for (const sort of ['time', 'relevance'] as const) {
      const snapshots: Array<{ outcome: string; pid?: number }> = [];
      const result = await f.store.searchMessagePassages(query, {
        visibleThreadIds: ['visible'],
        mode,
        sort,
        candidateOrder: 'relevance',
        deadlineAt: Date.now() + 15000,
        onReadSnapshot: (s) => snapshots.push(s),
      });
      assert.deepEqual(
        f.calls.at(-1),
        [instruction + query],
        'the provider must receive the upstream query task once, never zero or twice',
      );
      assert.equal(snapshots.at(-1)?.outcome, 'fulfilled');
      assert.ok(snapshots.at(-1)?.pid);
      assert.equal(result.meta.degraded, false);
      assert.equal(result.meta.effectiveMode, mode);
      if (sort === 'time') previous = result;
      else assert.deepEqual(result, previous);
    }
  }
  assert.equal(f.calls.length, 4, 'one existing embedding request per retrieval');
  const longQuery = 'Ibis ' + '汉'.repeat(1600);
  await f.store.searchMessagePassages(longQuery, {
    visibleThreadIds: ['visible'],
    mode: 'semantic',
    deadlineAt: Date.now() + 15000,
  });
  assert.deepEqual(
    f.calls.at(-1),
    [instruction + longQuery],
    'complete caller query reaches the adapter without an application slice',
  );
});

test('query task does not enter indexing inputs; document searches use the same query protocol', async (t) => {
  const f = await fixture(t, qwen);
  const content = 'Ibis 文档正文保持原样。';
  await embedPassages({
    embedding: f.embedding,
    passageVectorStore: f.passages,
    passages: [{ docAnchor: 'thread-visible', passageId: 'msg-source', content }],
  });
  assert.deepEqual(f.calls.at(-1), [content], 'persisted document embeddings retain their original input space');
  for (const mode of ['semantic', 'hybrid'] as const) {
    await f.store.searchWithMeta('Ibis', {
      mode,
      depth: 'summary',
      limit: 1,
      deadlineAt: Date.now() + 15000,
    });
    assert.deepEqual(f.calls.at(-1), [instruction + 'Ibis']);
  }
  assert.equal(f.calls.length, 3);
});

test('a non-Qwen provider retains its unmodified query input', async (t) => {
  const f = await fixture(t, 'neutral-other-embedding');
  await f.store.searchMessagePassages('Ibis 配置', {
    visibleThreadIds: ['visible'],
    mode: 'hybrid',
    candidateOrder: 'relevance',
    deadlineAt: Date.now() + 15000,
  });
  assert.deepEqual(f.calls, [['Ibis 配置']]);
});

test('the real HTTP adapter preserves explicit query payload and raw forwarding without guessing from user text', async (t) => {
  const calls: string[][] = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(typeof init?.body, 'string');
    const body = JSON.parse(init.body as string) as { input: string[] };
    calls.push(body.input);
    return Response.json({ model: qwen, data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0, 0] })) });
  });
  const embedding = new EmbeddingService({ embedModel: qwen, embedDim: 4, embedTimeoutMs: 2000, maxModelMemMb: 800 });
  embedding.markReady(qwen);
  const borrowed = createSearchEmbeddingCapability(embedding, () => true);
  const literalUserQuery = instruction + 'Ibis';
  await borrowed.embedQueries([literalUserQuery]);
  await borrowed.embed([instruction + 'Ibis']);
  assert.deepEqual(calls, [[instruction + literalUserQuery], [instruction + 'Ibis']]);
});
