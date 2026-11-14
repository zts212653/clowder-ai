import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openVectorGeneration } from '../../dist/domains/memory/open-vector-generation.js';
import { passageVectorKey } from '../../dist/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

test('G1 uses the existing file worker and native K2000 read window at 1024 dimensions', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'generation-worker-1024-'));
  const store = new SqliteEvidenceStore(join(root, 'evidence.sqlite'));
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(root, { force: true, recursive: true });
  });
  await store.upsert([
    {
      anchor: 'thread-neutral',
      title: 'Neutral',
      kind: 'thread',
      status: 'active',
      sourceHash: 'a',
      updatedAt: '2026-11-09',
    },
  ]);
  openVectorGeneration(
    store.getDb(),
    { modelId: 'old', modelRev: '1', dim: 768, generationId: 'g0' },
    { create: true },
  );
  const model = {
    modelId: 'neutral-new',
    modelRev: '1',
    dim: 1024,
    generationId: 'g1',
    representationFingerprint: 'a'.repeat(64),
  };
  const backend = openVectorGeneration(store.getDb(), model, { create: true });
  backend.vectorStore.initMeta(model);
  const vector = new Float32Array(1024);
  vector[0] = 1;
  const insert = store
    .getDb()
    .prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)');
  store.getDb().transaction(() => {
    for (let i = 0; i < 2000; i++) {
      insert.run('thread-neutral', `msg-${i}`, 'A neutral local fixture sentence.', '2026-11-09');
      backend.passageVectorStore.upsert(passageVectorKey('thread-neutral', `msg-${i}`), vector);
    }
  })();
  const embedding = {
    isReady: () => true,
    reprobeIfNeeded: async () => {},
    load: async () => {},
    dispose() {},
    getModelInfo: () => model,
    embed: async (texts) => texts.map(() => vector),
  };
  store.setEmbedDeps({ embedding, ...backend, mode: 'on' });
  const reads = [];
  const results = [];
  for (const sort of ['time', 'relevance'])
    results.push(
      await store.searchMessagePassages('neutral', {
        mode: 'semantic',
        sort,
        candidateOrder: 'relevance',
        candidateLimit: 2000,
        visibleThreadIds: ['neutral'],
        deadlineAt: Date.now() + 15000,
        onReadSnapshot: (s) => reads.push(s),
      }),
    );
  assert.equal(results[0].meta.degraded, false);
  assert.equal(results[0].passages.length, 2000);
  assert.deepEqual(results[0].passages, results[1].passages);
  const settled = reads.filter((read) => read.outcome === 'fulfilled');
  assert.equal(settled.length, 2);
  for (const read of settled) {
    assert.ok(read.pid > 0);
    assert.equal(read.nativeVectorRead.native.requestedK, 2000);
    assert.equal(read.nativeVectorRead.native.dimensions, 1024);
    assert.equal(read.nativeVectorRead.event, 'sql-finish');
  }
});
