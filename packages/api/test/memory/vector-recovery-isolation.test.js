import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readEmbeddingDeployment } from '../../dist/domains/memory/embedding-generation-config.js';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { MemoryEmbeddingLifecycle } from '../../dist/domains/memory/MemoryEmbeddingLifecycle.js';
import { openVectorGeneration } from '../../dist/domains/memory/open-vector-generation.js';
import { ShadowVectorGenerationBuilder } from '../../dist/domains/memory/ShadowVectorGenerationBuilder.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { generationIdentity } from '../../dist/domains/memory/vector-generation-identity.js';
import { inspectStoreVectorGeneration } from '../../dist/domains/memory/vector-generation-inspection.js';
import { inspectVectorGeneration } from '../../dist/domains/memory/vector-generation-readiness.js';

const model = { modelId: 'isolated-recovery', modelRev: 'fixture', generationId: 'g0', dim: 4 };
const unit = () => new Float32Array([1, 0, 0, 0]);

async function fixture(t, count = 2048) {
  const root = mkdtempSync(join(tmpdir(), 'vector-recovery-isolation-'));
  const store = new SqliteEvidenceStore(join(root, 'evidence.sqlite'));
  await store.initialize();
  await store.upsert([
    { anchor: 'thread-source', kind: 'thread', status: 'active', title: 'Fixture', updatedAt: '2026-11-10' },
  ]);
  const db = store.getDb();
  const insert = db.prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)');
  db.transaction(() => {
    for (let i = 0; i < count; i++)
      insert.run('thread-source', `msg-${String(i).padStart(7, '0')}`, `Synthetic ${i}`, '2026-11-10');
  })();
  const backend = openVectorGeneration(db, model, { create: true });
  backend.vectorStore.initMeta(model);
  backend.vectorStore.upsert('thread-source', unit());
  db.transaction(() => {
    for (let i = 0; i < count - 4; i++)
      backend.passageVectorStore.upsert(JSON.stringify(['thread-source', `msg-${String(i).padStart(7, '0')}`]), unit());
    db.prepare("INSERT INTO vector_generations VALUES('g0',?,'building')").run(generationIdentity(model));
  })();
  const inputs = [];
  const provider = {
    load: async () => {},
    isReady: () => true,
    getModelInfo: () => ({ ...model }),
    dispose() {},
    reprobeIfNeeded: async () => {},
    embed: async (texts) => {
      inputs.push(...texts);
      return texts.map(unit);
    },
  };
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { store, db, backend, provider, inputs };
}

function observeMainScans(db) {
  const scans = [];
  const original = db.prepare;
  db.prepare = function (sql) {
    const statement = Reflect.apply(original, this, [sql]);
    if (/\bLEFT JOIN\b/i.test(sql) && /(?:evidence_(?:docs|passages)|_rowids)/i.test(sql)) {
      for (const method of ['get', 'all', 'iterate']) {
        const call = statement[method];
        statement[method] = function (...args) {
          scans.push(sql);
          return Reflect.apply(call, this, args);
        };
      }
    }
    return statement;
  };
  return {
    scans,
    restore: () => {
      db.prepare = original;
    },
  };
}

test('file shadow recovery keeps pending/orphan/coverage scans out of the API connection and commits bounded source batches', async (t) => {
  const f = await fixture(t);
  const observed = observeMainScans(f.db);
  t.after(observed.restore);
  const childEvents = [];
  const events = channel('cat-cafe.memory-process');
  const record = (event) => childEvents.push(event);
  events.subscribe(record);
  t.after(() => events.unsubscribe(record));
  const result = await new ShadowVectorGenerationBuilder(f.store, f.provider).build({
    deadlineAt: Date.now() + 10000,
    maxBatches: 2,
    batchSize: 2,
  });
  assert.equal(result.committed, 4);
  assert.equal(result.status, 'ready');
  assert.equal(f.inputs.length, 4);
  assert.equal(
    observed.scans.length,
    0,
    'the complete recovery entry must not run full anti-joins on the API connection',
  );
  assert.ok(
    childEvents.some((event) => event.pid !== process.pid),
    'heavy reads crossed the real child-process boundary',
  );
  assert.equal(
    childEvents.filter((event) => event.kind === 'vector-generation-read').length,
    2,
    'one pending page must serve both encoder batches, followed by one final coverage read',
  );
});

test('lifecycle repair admission and final cohort publication also isolate their full scans', async (t) => {
  const f = await fixture(t);
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const deployment = readEmbeddingDeployment();
  const observed = observeMainScans(f.db);
  t.after(observed.restore);
  const lifecycle = new MemoryEmbeddingLifecycle(
    f.store,
    new IndexBuilder(f.store, '/unused'),
    {
      embedMode: 'on',
      embedModel: model.modelId,
      embedDim: model.dim,
      embedTimeoutMs: 100,
      maxModelMemMb: 32,
    },
    { getDeployment: () => deployment, createEmbeddingService: () => f.provider },
  );
  t.after(() => lifecycle.deactivate());
  assert.equal((await lifecycle.activate('on')).ok, true);
  assert.equal(f.inputs.length, 4);
  assert.equal(f.store.searchEmbedding().getModelInfo().modelId, model.modelId);
  assert.equal(
    observed.scans.length,
    0,
    'startup inspection, repair and final publication must all cross the child boundary',
  );
  const detail = warnings.find(([message]) => message === '[memory] vector cohort admission incomplete')?.[1];
  assert.deepEqual(detail, {
    generationId: 'g0',
    storeIndex: 0,
    reason: 'coverage_incomplete',
    missingDocuments: 0,
    missingPassages: 4,
    orphanDocuments: 0,
    orphanPassages: 0,
  });
  assert.doesNotMatch(JSON.stringify(warnings), /Synthetic|thread-source|evidence\.sqlite|isolated-recovery/);
});

test('retiring an activation stops its owned native maintenance before releasing writer admission', async (t) => {
  const f = await fixture(t);
  const lifecycle = new MemoryEmbeddingLifecycle(
    f.store,
    new IndexBuilder(f.store, '/unused'),
    {
      embedMode: 'on',
      embedModel: model.modelId,
      embedDim: 4,
      embedTimeoutMs: 100,
      maxModelMemMb: 32,
    },
    { createEmbeddingService: () => f.provider },
  );
  t.after(() => lifecycle.deactivate());
  const events = channel('cat-cafe.memory-process');
  let pid;
  const cancel = (event) => {
    if (event.kind !== 'vector-generation-reconcile' || pid) return;
    pid = event.pid;
    lifecycle.deactivate();
  };
  events.subscribe(cancel);
  t.after(() => events.unsubscribe(cancel));
  const result = await lifecycle.activate('on');
  assert.equal(result.ok, false);
  assert.equal(lifecycle.getStatus(), 'off');
  assert.equal(f.store.searchEmbedding(), undefined);
  assert.equal(f.inputs.length, 0);
  assert.ok(pid > 0, 'the real maintenance child reached native admission');
  await f.store.runExclusive(() => {
    assert.throws(
      () => process.kill(pid, 0),
      { code: 'ESRCH' },
      'owned native writer must exit before the next queue item',
    );
  });
});

test('a buffered recovery page cannot encode deleted or changed sources from an earlier batch', async (t) => {
  const f = await fixture(t, 12);
  let calls = 0;
  const ordinaryEmbed = f.provider.embed;
  f.provider.embed = async (texts) => {
    const vectors = await ordinaryEmbed(texts);
    if (++calls === 1) {
      await f.store.runExclusive(() => {
        f.db.prepare("DELETE FROM evidence_passages WHERE passage_id='msg-0000010'").run();
        f.db.prepare("UPDATE evidence_passages SET content='Current replacement' WHERE passage_id='msg-0000011'").run();
      });
    }
    return vectors;
  };
  const first = await new ShadowVectorGenerationBuilder(f.store, f.provider).build({
    deadlineAt: Date.now() + 10000,
    maxBatches: 2,
  });
  assert.equal(first.status, 'paused');
  assert.equal(first.committed, 2);
  assert.deepEqual(f.inputs, ['Synthetic 8', 'Synthetic 9'], 'stale buffered bodies never reach the encoder');
  const second = await new ShadowVectorGenerationBuilder(f.store, f.provider).build({
    deadlineAt: Date.now() + 10000,
    maxBatches: 2,
  });
  assert.equal(second.status, 'ready');
  assert.equal(second.committed, 1);
  assert.deepEqual(f.inputs, ['Synthetic 8', 'Synthetic 9', 'Current replacement']);
});

test('an off-thread coverage proof keeps the canonical cut hash and retires on either connection writing', async (t) => {
  const f = await fixture(t, 12);
  await new ShadowVectorGenerationBuilder(f.store, f.provider).build({ deadlineAt: Date.now() + 10000, maxBatches: 2 });
  const proof = await f.store.runExclusive(() => inspectStoreVectorGeneration(f.store, model));
  assert.deepEqual(proof.coverage, inspectVectorGeneration(f.db, model));
  assert.equal(proof.isCurrent(), true);
  f.db.prepare("INSERT INTO embedding_meta(key,value) VALUES('controlled_observation','1')").run();
  assert.equal(proof.isCurrent(), false, 'even a same-connection write retires the detached snapshot');
  const next = await f.store.runExclusive(() => inspectStoreVectorGeneration(f.store, model));
  const other = new SqliteEvidenceStore(f.db.name);
  await other.initialize();
  try {
    other
      .getDb()
      .prepare("UPDATE evidence_passages SET content='Changed by another connection' WHERE passage_id='msg-0000001'")
      .run();
    assert.equal(next.isCurrent(), false, 'cross-connection commits retire the coverage snapshot');
    assert.equal(
      f.db.transaction(() => next.isCurrent()).immediate(),
      false,
      'the short publication transaction must also reject the stale coverage proof',
    );
  } finally {
    other.close();
  }
});

test('canceling a pending recovery read kills its child and never reaches encoding', async (t) => {
  const f = await fixture(t, 8192);
  const caller = new AbortController();
  const events = channel('cat-cafe.memory-process');
  let pid;
  const cancel = (event) => {
    if (event.kind !== 'vector-generation-read' || pid) return;
    pid = event.pid;
    caller.abort(new DOMException('Controlled native read cancellation', 'AbortError'));
  };
  events.subscribe(cancel);
  t.after(() => events.unsubscribe(cancel));
  await assert.rejects(
    new ShadowVectorGenerationBuilder(f.store, f.provider).build({
      signal: caller.signal,
      deadlineAt: Date.now() + 10000,
      maxBatches: 2,
    }),
    (error) => error === caller.signal.reason,
  );
  assert.equal(f.inputs.length, 0);
  assert.ok(pid > 0);
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, 'canceled native SQL must not keep burning CPU');
});
