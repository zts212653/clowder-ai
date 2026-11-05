import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as yieldToIo } from 'node:timers/promises';
import * as sqliteVec from 'sqlite-vec';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { PassageVectorStore } from '../../dist/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { ensurePassageVectorTable, ensureVectorTable } from '../../dist/domains/memory/schema.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';

async function fixture(t, count = 20) {
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  t.after(() => store.close());
  const db = store.getDb();
  sqliteVec.load(db);
  ensureVectorTable(db, 4);
  ensurePassageVectorTable(db, 4);
  db.prepare(
    "INSERT INTO evidence_docs(anchor,kind,status,title,updated_at) VALUES('neutral','thread','active','Neutral','2026-01-01')",
  ).run();
  const put = db.prepare(
    "INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES('neutral',?,?,'2026-01-01T00:00:00Z')",
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) put.run(`p${i}`, 'private-body');
  })();
  const embedding = {
    isReady: () => true,
    reprobeIfNeeded: async () => {},
    getModelInfo: () => ({ modelId: 'neutral', modelRev: '1', dim: 4 }),
    embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0, 0])),
  };
  const passages = new PassageVectorStore(db, 4);
  const builder = new IndexBuilder(store, '/neutral-fixture', {
    embedding,
    vectorStore: new VectorStore(db, 4),
    passageVectorStore: passages,
  });
  return { store, db, builder, embedding, passages };
}
async function run(builder) {
  builder.startPassageEmbeddingWarmup();
  builder.startPassageEmbeddingWarmup();
  await yieldToIo();
  while (builder.isPassageWarmupActive()) await yieldToIo();
}

for (const path of ['fulfilled', 'rejected', 'retired'])
  test(`one warmup outcome per actual single-flight run: ${path}`, async (t) => {
    const f = await fixture(t);
    const events = [];
    t.mock.method(console, 'info', (msg, event) => {
      if (msg === '[memory] passage warmup outcome') events.push(event);
    });
    if (path === 'rejected')
      f.embedding.reprobeIfNeeded = async () => {
        await yieldToIo();
        throw new Error('private-provider-error');
      };
    if (path === 'retired') {
      const keys = f.passages.existingKeys.bind(f.passages);
      f.passages.existingKeys = (k) => {
        setImmediate(() => f.builder.setEmbedDeps(undefined));
        return keys(k);
      };
    }
    await run(f.builder);
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, path);
    assert.ok(events[0].elapsedMs >= 0);
    assert.equal(events[0].scanExhausted, path === 'fulfilled');
    assert.equal(events[0].committedVectors, path === 'fulfilled' ? 20 : 0);
    assert.equal(events[0].pagesRead, path === 'rejected' ? 0 : 1);
    assert.doesNotMatch(JSON.stringify(events), /private-|SELECT|modelId/);
    if (path === 'rejected') {
      f.embedding.reprobeIfNeeded = async () => {};
      await run(f.builder);
      assert.equal(events.length, 2);
      assert.equal(events[1].outcome, 'fulfilled');
      assert.equal(events[1].committedVectors, 20);
    }
  });

test('warmup logging failure preserves cleanup and successful vector work', async (t) => {
  const f = await fixture(t);
  t.mock.method(console, 'info', () => {
    throw new Error('sink down');
  });
  await run(f.builder);
  assert.equal(f.passages.count(), 20);
  assert.equal(f.builder.isPassageWarmupActive(), false);
});

for (const kind of ['metadata-read-error', 'consecutive-batch-errors', 'partial-success'])
  test(`warmup keeps bounded partial counts: ${kind}`, async (t) => {
    const f = await fixture(t, kind === 'consecutive-batch-errors' ? 768 : 20);
    const events = [];
    t.mock.method(console, 'info', (msg, event) => {
      if (msg === '[memory] passage warmup outcome') events.push(event);
    });
    if (kind === 'metadata-read-error') {
      const prepare = f.db.prepare.bind(f.db);
      f.db.prepare = (sql) => {
        if (sql.includes('FROM evidence_passages WHERE')) throw new Error('private SQLite failure');
        return prepare(sql);
      };
    }
    if (kind === 'consecutive-batch-errors')
      f.embedding.embed = async () => {
        throw new Error('private provider failure');
      };
    if (kind === 'partial-success') {
      let calls = 0;
      const embed = f.embedding.embed;
      f.embedding.embed = async (texts) => {
        if (++calls === 2) throw new Error('private second batch');
        return embed(texts);
      };
    }
    await run(f.builder);
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.outcome, kind === 'partial-success' ? 'fulfilled' : 'rejected');
    if (kind === 'metadata-read-error') {
      assert.equal(e.stopReason, kind);
      assert.equal(e.metadataRows, 0);
    }
    if (kind === 'consecutive-batch-errors') {
      assert.equal(e.pagesRead, 3);
      assert.equal(e.batchFailures, 3);
      assert.equal(e.scanExhausted, false);
    }
    if (kind === 'partial-success') {
      assert.equal(e.scanExhausted, true);
      assert.equal(e.committedVectors, 8);
      assert.equal(e.missingBodies, 20);
      assert.equal(e.batchFailures, 1);
    }
    assert.doesNotMatch(JSON.stringify(e), /private|SELECT/);
  });

test('provider return is observed before writer queue and dependency retirement blocks only commits', async (t) => {
  const f = await fixture(t, 1);
  const events = [];
  let providerReturnedBatches = 0;
  t.mock.method(console, 'info', (msg, event) => {
    if (msg === '[memory] passage warmup outcome') events.push(event);
  });
  f.embedding.embed = async (texts) => {
    await yieldToIo();
    providerReturnedBatches++;
    f.builder.setEmbedDeps(undefined);
    return texts.map(() => new Float32Array([1, 0, 0, 0]));
  };
  await run(f.builder);
  assert.equal(providerReturnedBatches, 1);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.pagesRead, 1);
  assert.equal(e.missingBodies, 1);
  assert.equal(e.returnedBatches, providerReturnedBatches);
  assert.equal(e.committedVectors, 0);
  assert.equal(f.passages.count(), 0);
  assert.equal(e.outcome, 'retired');
  assert.equal(e.stopReason, 'dependencies-changed', 'first observed terminal reason must survive the next loop guard');
  assert.equal(e.scanExhausted, false);
  t.diagnostic(
    JSON.stringify({ kind: 'neutral in-flight provider return retirement', providerReturnedBatches, event: e }),
  );
});
