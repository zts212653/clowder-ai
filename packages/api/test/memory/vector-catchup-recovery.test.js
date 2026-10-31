import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as sqliteVec from 'sqlite-vec';
import { embedIndexedItems } from '../../dist/domains/memory/embed-utils.js';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { MemoryEmbeddingLifecycle } from '../../dist/domains/memory/MemoryEmbeddingLifecycle.js';
import { PassageVectorStore } from '../../dist/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { ensurePassageVectorTable, ensureVectorTable } from '../../dist/domains/memory/schema.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';

async function fixture(t, embed, count = 1) {
  const root = mkdtempSync(join(tmpdir(), 'vector-catchup-'));
  mkdirSync(join(root, 'features'));
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  const db = store.getDb();
  sqliteVec.load(db);
  ensureVectorTable(db, 4);
  ensurePassageVectorTable(db, 4);
  const vectors = new VectorStore(db, 4),
    passages = new PassageVectorStore(db, 4);
  const model = { modelId: 'controlled-vector', modelRev: '1', dim: 4 };
  vectors.initMeta(model);
  const service = {
    load: async () => {},
    reprobeIfNeeded: async () => {},
    isReady: () => true,
    getModelInfo: () => model,
    dispose() {},
    embed,
  };
  const builder = new IndexBuilder(store, root);
  const lifecycle = new MemoryEmbeddingLifecycle(
    store,
    builder,
    { embedMode: 'on', embedModel: model.modelId, embedDim: 4, embedTimeoutMs: 3000, maxModelMemMb: 800 },
    {
      createEmbeddingService: () => service,
      initializeVectorBackend: async () => ({ vectorStore: vectors, passageVectorStore: passages }),
    },
  );
  t.after(() => {
    lifecycle.deactivate();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  await store.upsert(
    Array.from({ length: count }, (_, i) => ({
      anchor: `doc-${String(i).padStart(3, '0')}`,
      kind: 'plan',
      status: 'active',
      title: `Neutral document ${i}`,
      summary: 'A complete retained source summary.',
      sourcePath: `plans/${i}.md`,
      sourceHash: `source-${i}`,
      updatedAt: '2026-10-23T00:00:00Z',
    })),
  );
  assert.equal((await lifecycle.activate('on')).ok, true);
  return { root, store, builder, lifecycle, vectors, service };
}
const output = (texts) => texts.map(() => new Float32Array([1, 0, 0, 0]));
const drain = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

test('document catch-up uses bounded existing background work under the unchanged 3000ms deadline', async (t) => {
  const sizes = [];
  const f = await fixture(
    t,
    async (texts) => {
      sizes.push(texts.length);
      if (texts.length * 55 > 3000)
        throw new DOMException('controlled per-row work exceeds the existing deadline', 'TimeoutError');
      return output(texts);
    },
    72,
  );
  const result = await f.builder.embedMissingDocumentVectors();
  assert.equal(result.docsEmbedded, 72);
  assert.equal(f.vectors.count(), 72);
  assert.equal(f.store.getDb().prepare('SELECT count(*) AS n FROM document_vector_sources').get().n, 72);
  assert.ok(sizes.every((n) => n * 55 <= 3000));
  t.diagnostic(
    JSON.stringify({
      kind: 'controlled per-row work witness, not provider speed',
      budgetMs: 3000,
      perRowVirtualMs: 55,
      batchSizes: sizes,
    }),
  );
});

test('shared document embedding entry respects the same bounded background work', async () => {
  const sizes = [],
    anchors = [];
  const items = Array.from({ length: 72 }, (_, i) => ({ anchor: `d-${i}`, title: `Neutral ${i}` }));
  await embedIndexedItems({
    items,
    embedding: {
      reprobeIfNeeded: async () => {},
      isReady: () => true,
      getModelInfo: () => ({ modelId: 'controlled', modelRev: '1', dim: 4 }),
      embed: async (texts) => {
        sizes.push(texts.length);
        if (texts.length * 55 > 3000) throw new DOMException('controlled batch deadline', 'TimeoutError');
        return output(texts);
      },
    },
    vectorStore: { upsert: (anchor) => anchors.push(anchor), initMeta() {} },
  });
  assert.deepEqual(
    anchors,
    items.map((x) => x.anchor),
  );
  assert.ok(sizes.every((n) => n * 55 <= 3000));
});

test('document failure does not bypass the independent passage warmup entry', async (t) => {
  const failure = new DOMException('controlled transient document timeout', 'TimeoutError');
  const f = await fixture(t, async () => {
    throw failure;
  });
  let warmups = 0;
  f.builder.startPassageEmbeddingWarmup = () => warmups++;
  await assert.rejects(f.lifecycle.catchUpAfterReady(), (error) => error === failure);
  assert.equal(warmups, 1);
  assert.equal(f.vectors.count(), 0);
  assert.equal(f.store.getDb().prepare('SELECT count(*) AS n FROM document_vector_sources').get().n, 0);
});

test('failed current source remains pending and resumes without another startup, source scan or force', async (t) => {
  let calls = 0;
  const f = await fixture(t, async (texts) => {
    if (++calls === 1) throw new DOMException('transient document timeout', 'TimeoutError');
    return output(texts);
  });
  f.builder.startPassageEmbeddingWarmup = () => {};
  f.builder.rebuild = () => assert.fail('retry cannot rescan the corpus');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await assert.rejects(f.lifecycle.catchUpAfterReady(), { name: 'TimeoutError' });
  assert.equal(f.vectors.count(), 0);
  t.mock.timers.tick(29999);
  await drain();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await drain();
  assert.equal(calls, 2, 'the original lifecycle must retry its still-pending source after the existing 30s cadence');
  assert.equal(f.vectors.count(), 1);
  assert.equal(
    f.store.getDb().prepare('SELECT source_hash FROM document_vector_sources WHERE anchor=?').get('doc-000')
      .source_hash,
    'source-0',
  );
});

test('overlapping ready and thread catch-up consumers share one document attempt', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const f = await fixture(t, async (texts) => {
    calls++;
    await gate;
    return output(texts);
  });
  f.builder.startPassageEmbeddingWarmup = () => {};
  const first = f.lifecycle.catchUpAfterReady(),
    second = f.lifecycle.catchUpAfterReady();
  try {
    await drain();
    assert.equal(calls, 1, 'do not duplicate the pending corpus request');
  } finally {
    release();
    await Promise.all([first, second]);
  }
});

test('deactivation cancels recovery instead of embedding after the owner is disabled', async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    throw new DOMException('unavailable', 'TimeoutError');
  });
  f.builder.startPassageEmbeddingWarmup = () => {};
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await assert.rejects(f.lifecycle.catchUpAfterReady());
  f.lifecycle.deactivate();
  t.mock.timers.tick(90000);
  await drain();
  assert.equal(calls, 1);
  assert.equal(f.vectors.count(), 0);
});

test('disabling during an in-flight batch prevents subsequent requests and stale commits', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const f = await fixture(
    t,
    async (texts) => {
      calls++;
      await gate;
      return output(texts);
    },
    72,
  );
  let warmups = 0;
  f.builder.startPassageEmbeddingWarmup = () => warmups++;
  const attempt = f.lifecycle.catchUpAfterReady();
  await drain();
  f.lifecycle.deactivate();
  release();
  await attempt;
  assert.equal(calls, 1, 'disabled work must not issue the next batch');
  assert.equal(f.vectors.count(), 0);
  assert.equal(warmups, 0, 'a retired lifecycle cannot start fresh passage work');
});

for (const cold of [false, true])
  test(`recovery retains committed batches and only fills current missing sources (cold model metadata: ${cold})`, async (t) => {
    const successful = [];
    let calls = 0;
    const f = await fixture(
      t,
      async (texts) => {
        if (++calls === 2) throw new DOMException('transient middle batch timeout', 'TimeoutError');
        successful.push(...texts);
        return output(texts);
      },
      72,
    );
    if (cold) f.vectors.clearAll();
    f.builder.startPassageEmbeddingWarmup = () => {};
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await assert.rejects(f.lifecycle.catchUpAfterReady(), { name: 'TimeoutError' });
    assert.ok(f.vectors.count() > 0 && f.vectors.count() < 72);
    t.mock.timers.tick(30000);
    await drain();
    assert.ok(calls > 2, 'the timer must start recovery before the test joins it');
    await f.lifecycle.catchUpAfterReady();
    assert.equal(f.vectors.count(), 72);
    assert.equal(successful.length, 72, 'already committed current vectors must not be embedded again');
    assert.equal(new Set(successful).size, 72);
  });

test('deferred API startup publishes lexical evidence before document-vector work and the existing catch-up fills it', async (t) => {
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const embeddingEntered = new Promise((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const f = await fixture(t, async (texts) => {
    calls++;
    entered();
    await gate;
    return output(texts);
  });
  f.builder.startPassageEmbeddingWarmup = () => {};
  writeFileSync(
    join(f.root, 'features', 'F901-service.md'),
    '---\nfeature_ids: [F901]\nstatus: active\n---\n# Neutral startup service\n\nneutralstartuptoken remains available while vector work waits.\n',
  );
  const startup = f.builder.rebuild({ deferThreadIndexing: true, deferDocumentEmbedding: true });
  try {
    const first = await Promise.race([
      startup.then(() => 'lexical-ready'),
      embeddingEntered.then(() => 'embedding-blocked'),
    ]);
    assert.equal(first, 'lexical-ready', 'healthy small batches must not turn a startup into a full-vector drain');
    assert.equal(calls, 0);
    assert.ok(await f.store.getByAnchor('F901'));
    assert.ok(f.store.searchPassages('neutralstartuptoken').length > 0);
    assert.equal(f.vectors.count(), 0);
  } finally {
    release();
    await startup;
  }
  const caughtUp = await f.lifecycle.catchUpAfterReady();
  assert.equal(caughtUp.docsEmbedded, 1);
  assert.equal(f.vectors.count(), 1);
});
