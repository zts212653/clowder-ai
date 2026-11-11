import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openVectorGeneration } from '../../dist/domains/memory/open-vector-generation.js';
import { ShadowVectorGenerationBuilder } from '../../dist/domains/memory/ShadowVectorGenerationBuilder.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { inspectVectorGeneration } from '../../dist/domains/memory/vector-generation-readiness.js';

const model = {
  modelId: 'fixture-new',
  modelRev: '1',
  dim: 6,
  generationId: 'g1',
  representationFingerprint: 'a'.repeat(64),
};
const vector = () => new Float32Array([1, 0, 0, 0, 0, 0]);
function provider(onEmbed = async () => {}) {
  const inputs = [];
  return {
    inputs,
    load: async () => {},
    isReady: () => true,
    reprobeIfNeeded: async () => {},
    dispose() {},
    getModelInfo: () => ({ ...model }),
    embed: async (texts, signal) => {
      inputs.push(...texts);
      await onEmbed(texts, signal);
      return texts.map(vector);
    },
  };
}
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'shadow-vector-generation-'));
  const path = join(root, 'evidence.sqlite');
  let store = new SqliteEvidenceStore(path);
  await store.initialize();
  await store.upsert(
    ['a', 'b'].map((id) => ({
      anchor: `thread-${id}`,
      kind: 'thread',
      status: 'active',
      title: `Neutral ${id}`,
      summary: 'fixture body',
      updatedAt: '2026-11-09',
    })),
  );
  const insert = store
    .getDb()
    .prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)');
  for (const id of ['a', 'b'])
    for (const n of [1, 2]) insert.run(`thread-${id}`, `msg-${n}`, `Neutral source ${id} ${n}`, '2026-11-09');
  const old = openVectorGeneration(store.getDb(), { modelId: 'legacy', modelRev: 'unknown', dim: 4 }, { create: true });
  old.vectorStore.upsert('thread-a', new Float32Array([1, 0, 0, 0]));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    old,
    async reopen() {
      store.close();
      store = new SqliteEvidenceStore(path);
      await store.initialize();
    },
  };
}
const options = (extra = {}) => ({ deadlineAt: Date.now() + 10000, maxBatches: 10, batchSize: 2, ...extra });

test('shadow build pauses, reopens, resumes only unfinished sources and leaves G0 serving', async (t) => {
  const f = await fixture(t);
  const encoder = provider();
  const first = await new ShadowVectorGenerationBuilder(f.store, encoder).build(options({ maxBatches: 1 }));
  assert.equal(first.status, 'paused');
  assert.equal(first.committed, 2);
  assert.equal(f.old.vectorStore.count(), 1);
  const prefix = f.store
    .getDb()
    .prepare('SELECT embedding FROM evidence_vectors_g1 WHERE anchor=?')
    .get('thread-a').embedding;
  assert.equal(inspectVectorGeneration(f.store.getDb(), model).ready, false);
  await f.reopen();
  const second = await new ShadowVectorGenerationBuilder(f.store, encoder).build(options());
  assert.equal(second.status, 'ready');
  assert.equal(second.committed, 4);
  assert.equal(encoder.inputs.length, 6, 'completed prefix is not re-encoded after reopening');
  assert.deepEqual(
    f.store.getDb().prepare('SELECT embedding FROM evidence_vectors_g1 WHERE anchor=?').get('thread-a').embedding,
    prefix,
  );
  assert.equal(inspectVectorGeneration(f.store.getDb(), model).ready, true);
  assert.equal(f.store.getDb().prepare('SELECT count(*) AS n FROM evidence_vectors').get().n, 1);
  const next = openVectorGeneration(f.store.getDb(), model);
  f.store.setEmbedDeps({ embedding: encoder, ...next, mode: 'on' });
  const snapshots = [];
  const result = await f.store.searchMessagePassages('meaning without literal match', {
    visibleThreadIds: ['a'],
    mode: 'semantic',
    candidateOrder: 'relevance',
    sort: 'time',
    candidateLimit: 32,
    deadlineAt: Date.now() + 10000,
    onReadSnapshot: (s) => snapshots.push(s),
  });
  assert.equal(result.meta.effectiveMode, 'semantic');
  assert.equal(result.meta.degraded, false);
  assert.equal(result.passages.length, 2);
  assert.ok(result.passages.every((p) => p.threadId === 'a'));
  assert.ok(snapshots.at(-1).pid > 0, 'real worker crossed IPC and queried the G1 passage table');
});

test('canonical mutations during encode discard stale results and remain resumable', async (t) => {
  const f = await fixture(t);
  const encoder = provider(async () => {
    f.store.getDb().prepare("UPDATE evidence_docs SET title='Changed' WHERE anchor='thread-a'").run();
    await f.store.deleteByAnchor('thread-b');
  });
  const first = await new ShadowVectorGenerationBuilder(f.store, encoder).build(options({ maxBatches: 1 }));
  assert.equal(first.committed, 0);
  assert.equal(first.status, 'paused');
  assert.equal(f.store.getDb().prepare('SELECT count(*) AS n FROM evidence_vectors_g1').get().n, 0);
  const second = await new ShadowVectorGenerationBuilder(f.store, provider()).build(options());
  assert.equal(second.status, 'ready');
  assert.equal(
    f.store.getDb().prepare("SELECT count(*) AS n FROM evidence_vectors_g1 WHERE anchor='thread-b'").get().n,
    0,
  );
});

test('caller cancellation returns without waiting for uncooperative encoding or publishing late vectors', async (t) => {
  const f = await fixture(t);
  const caller = new AbortController();
  let release;
  const encoder = provider(
    async () =>
      new Promise((resolve) => {
        release = resolve;
        caller.abort(new DOMException('left', 'AbortError'));
      }),
  );
  await assert.rejects(new ShadowVectorGenerationBuilder(f.store, encoder).build(options({ signal: caller.signal })), {
    name: 'AbortError',
  });
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.store.getDb().prepare('SELECT count(*) AS n FROM evidence_vectors_g1').get().n, 0);
  assert.equal(inspectVectorGeneration(f.store.getDb(), model).ready, false);
});

test('source proof failure rolls back the vector, and a different representation cannot resume', async (t) => {
  const f = await fixture(t);
  f.store.getDb().exec(`CREATE TRIGGER reject_projection BEFORE INSERT ON document_vector_sources_g1
    WHEN new.revision_hash!='invalidated' BEGIN SELECT RAISE(ABORT,'controlled proof failure'); END`);
  await assert.rejects(
    new ShadowVectorGenerationBuilder(f.store, provider()).build(options()),
    /controlled proof failure/,
  );
  assert.equal(f.store.getDb().prepare('SELECT count(*) AS n FROM evidence_vectors_g1').get().n, 0);
  f.store.getDb().exec('DROP TRIGGER reject_projection');
  const wrong = provider();
  wrong.getModelInfo = () => ({ ...model, representationFingerprint: 'b'.repeat(64) });
  await assert.rejects(new ShadowVectorGenerationBuilder(f.store, wrong).build(options()), /another representation/);
  assert.equal(wrong.inputs.length, 0);
  const caller = new AbortController();
  assert.equal(
    (await new ShadowVectorGenerationBuilder(f.store, provider()).build(options({ signal: caller.signal }))).status,
    'ready',
  );
  assert.equal(caller.signal.aborted, false, 'the owned scope cannot abort its caller');
});
