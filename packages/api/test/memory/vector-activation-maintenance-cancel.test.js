import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { MemoryEmbeddingLifecycle } from '../../dist/domains/memory/MemoryEmbeddingLifecycle.js';
import { openVectorGeneration } from '../../dist/domains/memory/open-vector-generation.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { generationIdentity } from '../../dist/domains/memory/vector-generation-identity.js';

async function sparseReadyStore(t) {
  const root = mkdtempSync(join(tmpdir(), 'activation-native-owner-'));
  const store = new SqliteEvidenceStore(join(root, 'evidence.sqlite'));
  await store.initialize();
  const db = store.getDb();
  const model = { modelId: 'sparse-g0', modelRev: 'fixture', generationId: 'g0', dim: 4 };
  await store.upsert([
    { anchor: 'thread-sparse', kind: 'thread', title: 'Synthetic', status: 'active', updatedAt: '2026-11-11' },
  ]);
  const passage = db.prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)');
  db.transaction(() => {
    for (let chunk = 0; chunk < 32; chunk++)
      for (let offset = 0; offset < 256; offset++)
        passage.run('thread-sparse', `msg-${chunk * 1024 + offset}`, 'Current synthetic source', '2026-11-11');
  })();
  const backend = openVectorGeneration(db, model, { create: true });
  backend.vectorStore.initMeta(model);
  const unit = new Float32Array([1, 0, 0, 0]);
  backend.vectorStore.upsert('thread-sparse', unit);
  db.transaction(() => {
    for (let i = 0; i < 32 * 1024; i++)
      backend.passageVectorStore.upsert(JSON.stringify(['thread-sparse', `msg-${i}`]), unit);
    for (let i = 0; i < 32 * 1024; i++)
      if (i % 1024 >= 256) backend.passageVectorStore.delete(JSON.stringify(['thread-sparse', `msg-${i}`]));
    db.prepare("INSERT INTO vector_generations VALUES('g0',?,'ready')").run(generationIdentity(model));
  })();
  assert.equal(backend.passageVectorStore.count(), 8192);
  assert.equal(db.prepare('SELECT count(*) AS n FROM passage_vectors_chunks').get().n, 32);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const config = { embedMode: 'on', embedModel: model.modelId, embedDim: 4, embedTimeoutMs: 100, maxModelMemMb: 32 };
  const lifecycle = new MemoryEmbeddingLifecycle(store, new IndexBuilder(store, '/unused'), config, {
    createEmbeddingService: () => {
      let ready = false;
      return {
        load: async () => {
          ready = true;
        },
        isReady: () => ready,
        getModelInfo: () => ({ ...model }),
        embed: async () => {
          throw new Error('A complete fixture needs no model call');
        },
        reprobeIfNeeded: async () => {},
        dispose() {
          ready = false;
        },
      };
    },
  });
  t.after(() => lifecycle.deactivate());
  const maintenance = [];
  const repack = store.repackPassageVectors.bind(store);
  store.repackPassageVectors = (options) => {
    maintenance.push(options);
    return repack(options);
  };
  return { store, db, lifecycle, config, maintenance };
}

for (const action of ['deactivate', 'replace']) {
  test(`${action} cancels the activation-owned real sparse vector-repack before advancing its writer queue`, async (t) => {
    const f = await sparseReadyStore(t);
    let pid;
    let nextWriter;
    let replacement;
    const events = channel('cat-cafe.memory-process');
    const cancel = (event) => {
      if (event.kind !== 'vector-repack' || pid) return;
      pid = event.pid;
      if (action === 'deactivate') f.lifecycle.deactivate();
      else {
        f.config.embedTimeoutMs = 101;
        replacement = f.lifecycle.activate('on');
        void replacement.catch(() => {});
      }
      nextWriter = f.store.runExclusive(() => {
        assert.throws(
          () => process.kill(pid, 0),
          { code: 'ESRCH' },
          'retired native repack must exit before the next writer',
        );
      });
      void nextWriter.catch(() => {});
    };
    events.subscribe(cancel);
    t.after(() => events.unsubscribe(cancel));
    const retired = await f.lifecycle.activate('on');
    assert.ok(pid > 0, 'cancellation follows a real vector-repack started event');
    assert.equal(retired.ok, false);
    await nextWriter;
    assert.equal(f.maintenance[0].signal.aborted, true);
    assert.ok(Number.isFinite(f.maintenance[0].deadlineAt));
    assert.ok(
      f.maintenance[0].deadlineAt <= Date.now() + 15000,
      'activation layout maintenance receives the bounded native deadline, not the standalone 120s default',
    );
    if (action === 'deactivate') {
      assert.equal(f.lifecycle.getStatus(), 'off');
      assert.equal(f.store.searchEmbedding(), undefined);
    } else {
      assert.equal((await replacement).ok, true);
      assert.equal(f.lifecycle.getStatus(), 'ready');
    }
    assert.equal(
      f.db.prepare('SELECT count(*) AS n FROM passage_vectors_rowids').get().n,
      8192,
      'canceled native maintenance must leave every current vector intact',
    );
  });
}
