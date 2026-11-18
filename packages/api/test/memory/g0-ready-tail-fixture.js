import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { readEmbeddingDeployment } from '../../dist/domains/memory/embedding-generation-config.js';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { MemoryEmbeddingLifecycle } from '../../dist/domains/memory/MemoryEmbeddingLifecycle.js';
import { openVectorGeneration } from '../../dist/domains/memory/open-vector-generation.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { prepareGenerationInvalidationConnection } from '../../dist/domains/memory/vector-generation-invalidation.js';
import { inspectVectorGeneration } from '../../dist/domains/memory/vector-generation-readiness.js';

// File-backed stores, the real lifecycle and real read workers; only the encoder is a stub.

const unit = () => new Float32Array([1, 0, 0, 0]);
export const model = { modelId: 'fixture-model', modelRev: '1', dim: 4, generationId: 'g0' };
const config = {
  embedMode: 'on',
  embedModel: model.modelId,
  embedDim: 4,
  embedModelRev: '1',
  embedTimeoutMs: 1000,
  maxModelMemMb: 32,
};

/** `count` documents with two passages each. Every text contains "piano"; none contains "nocturne". */
export async function append(store, prefix, count) {
  await store.upsert(
    Array.from({ length: count }, (_, i) => ({
      anchor: `${prefix}-${i}`,
      title: `${prefix} piano ${i}`,
      kind: 'decision',
      status: 'active',
      sourceHash: `${prefix}-${i}`,
      updatedAt: '2026-11-16',
    })),
  );
  await store.runExclusive(() => {
    const insert = store
      .getDb()
      .prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)');
    for (let i = 0; i < count; i++)
      for (let n = 0; n < 2; n++)
        insert.run(`${prefix}-${i}`, `p-${n}`, `${prefix}-${i} piano passage ${n}`, '2026-11-16');
  });
}

export async function cohortFixture(t, { stores: count = 1 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'g0-ready-tail-'));
  const stores = Array.from({ length: count }, (_, i) => new SqliteEvidenceStore(join(root, `evidence-${i}.sqlite`)));
  for (const store of stores) {
    await store.initialize();
    await append(store, 'initial', 12);
    // Production reached a registered G0 through an explicit model rebuild; start from another identity.
    const old = { ...model, modelId: 'old-identity' };
    openVectorGeneration(store.getDb(), old, { create: true }).vectorStore.initMeta(old);
  }

  const running = [];
  const connections = [];
  /** `duringProbe` runs while a search asks the provider whether it is ready. */
  const hooks = {};
  /** One API process: a lifecycle and index builder over the same database files. */
  const boot = (encode = async () => {}, options = {}) => {
    const encoded = [];
    const lifecycle = new MemoryEmbeddingLifecycle(stores[0], new IndexBuilder(stores[0], '/unused'), config, {
      getDeployment: readEmbeddingDeployment,
      getDependentStores: () => stores,
      createEmbeddingService: () => {
        let ready = false;
        return {
          load: async () => {
            ready = true;
          },
          dispose: () => {
            ready = false;
          },
          isReady: () => ready,
          reprobeIfNeeded: async () => {
            await hooks.duringProbe?.();
          },
          getModelInfo: () => model,
          embed: async (texts, signal) => {
            await encode(texts, signal);
            encoded.push(...texts);
            return texts.map(unit);
          },
        };
      },
      ...options,
    });
    running.push(lifecycle);
    return { lifecycle, encoded };
  };
  t.after(() => {
    for (const lifecycle of running) lifecycle.deactivate();
    for (const connection of connections) connection.close();
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** Another writer on the same file that cannot load sqlite-vec: the existing path quarantines the store. */
  const quarantineFromAnotherConnection = (store = stores[0]) => {
    const writer = new Database(store.getDb().name);
    connections.push(writer);
    writer.loadExtension = () => {
      throw new Error('sqlite-vec is unavailable on this connection');
    };
    prepareGenerationInvalidationConnection(writer);
  };
  const registry = (store = stores[0]) =>
    store.getDb().prepare("SELECT state FROM vector_generations WHERE id='g0'").get()?.state;
  const coverage = (store = stores[0]) => inspectVectorGeneration(store.getDb(), model);
  /** Anchors that only a stored vector can return: the query word occurs in no fixture text. */
  const byVector = async (store = stores[0]) => {
    const result = await store.searchWithMeta('nocturne', {
      mode: 'hybrid',
      limit: 50,
      deadlineAt: Date.now() + 15_000,
    });
    return { meta: result.meta, anchors: result.items.map((item) => item.anchor) };
  };
  return { store: stores[0], stores, boot, hooks, registry, coverage, byVector, quarantineFromAnotherConnection };
}
