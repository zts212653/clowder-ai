import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { openVectorGeneration } from '../../dist/domains/memory/open-vector-generation.js';
import { passageVectorKey } from '../../dist/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { generationInvalidationState } from '../../dist/domains/memory/vector-generation-invalidation.js';
import { captureVectorSource, commitVectorSource } from '../../dist/domains/memory/vector-source-binding.js';

const unit = (dim) => Float32Array.from({ length: dim }, (_, i) => Number(i === 0));
const document = {
  anchor: 'thread-neutral',
  title: 'Original',
  summary: 'Body',
  kind: 'thread',
  status: 'active',
  sourceHash: 'one',
  updatedAt: '2026-11-09',
};
const passageKey = passageVectorKey(document.anchor, 'msg-neutral');
async function fixture(t, legacyFact = false) {
  const root = mkdtempSync(join(tmpdir(), 'generation-healthy-invalidation-'));
  const path = join(root, 'evidence.sqlite');
  const store = new SqliteEvidenceStore(path);
  await store.initialize();
  await store.upsert([document]);
  store
    .getDb()
    .prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)')
    .run(document.anchor, 'msg-neutral', 'Original passage', '2026-11-09');
  const models = [
    { modelId: 'g0-fixture', modelRev: '1', dim: 4, generationId: 'g0' },
    { modelId: 'g1-fixture', modelRev: '1', dim: 6, generationId: 'g1', representationFingerprint: 'a'.repeat(64) },
  ];
  const backends = models.map((model) => {
    const b = openVectorGeneration(store.getDb(), model, { create: true });
    b.vectorStore.initMeta(model);
    if (model.generationId === 'g1')
      store
        .getDb()
        .prepare("INSERT INTO vector_generations VALUES('g1',?,'ready')")
        .run(model.representationFingerprint);
    for (const [kind, key, target] of [
      ['documents', document.anchor, b.vectorStore],
      ['passages', passageKey, b.passageVectorStore],
    ])
      assert.equal(
        commitVectorSource(
          store.getDb(),
          target,
          captureVectorSource(store.getDb(), kind, key),
          unit(model.dim),
          model,
        ),
        true,
      );
    return b;
  });
  if (legacyFact)
    store.getDb().exec(`DROP TRIGGER vector_g0_passage_UPDATE;
    CREATE TRIGGER vector_g0_passage_UPDATE AFTER UPDATE ON evidence_passages BEGIN
    UPDATE passage_vector_sources SET revision_hash='invalidated' WHERE passage_key=json_array(new.doc_anchor,new.passage_id); END`);
  // This real writer initializes after physical tables exist: healthy native TEMP triggers are installed.
  const writer = new SqliteEvidenceStore(path);
  await writer.initialize();
  const reader = new Database(path, { readonly: true });
  for (const model of models) openVectorGeneration(reader, model);
  const embedding = {
    load: async () => {},
    reprobeIfNeeded: async () => {},
    isReady: () => true,
    getModelInfo: () => models[0],
    embed: async (texts) => texts.map(() => unit(4)),
  };
  store.setEmbedDeps({ ...backends[0], embedding, mode: 'on' });
  t.after(() => {
    reader.close();
    writer.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { store, writer, reader, models, backends };
}
function mutate(db, kind, action) {
  if (action === 'forget')
    db.prepare(`INSERT INTO message_recall_index_suppressions
    (doc_anchor,passage_id,lease_id,state,prepared_at,committed_at) VALUES(?,?,?,'committed',?,?)`).run(
      document.anchor,
      'msg-neutral',
      'fixture-lease',
      '2026-11-09',
      '2026-11-09',
    );
  else if (kind === 'documents')
    db.exec(
      action === 'update'
        ? "UPDATE evidence_docs SET title='Current title' WHERE anchor='thread-neutral'"
        : "DELETE FROM evidence_docs WHERE anchor='thread-neutral'",
    );
  else
    db.exec(
      action === 'update'
        ? "UPDATE evidence_passages SET content='Current passage' WHERE doc_anchor='thread-neutral'"
        : "DELETE FROM evidence_passages WHERE doc_anchor='thread-neutral'",
    );
}
async function staleNativeRead(t, generation, kind, action, legacyFact = false) {
  const f = await fixture(t, legacyFact),
    model = f.models[generation],
    backend = f.backends[generation];
  const target = openVectorGeneration(f.reader, model)[kind === 'documents' ? 'vectorStore' : 'passageVectorStore'];
  const before = generationInvalidationState(f.reader, backend.vectorStore.tables),
    borrowed = f.store.searchEmbedding();
  let seen = 0;
  const prepare = f.reader.prepare.bind(f.reader);
  f.reader.prepare = (sql) => {
    const statement = prepare(sql);
    if (sql.includes('embedding MATCH')) {
      const all = statement.all.bind(statement);
      statement.all = (...args) => {
        const rows = all(...args);
        seen += rows.length;
        mutate(f.writer.getDb(), kind, action);
        return rows;
      };
    }
    return statement;
  };
  const result = target.search(unit(model.dim), 1);
  f.reader.prepare = prepare;
  assert.equal(seen, 1, 'the actual native KNN completed before the healthy writer mutation');
  assert.equal(f.writer.getDb().prepare(`SELECT count(*) AS n FROM ${backend.vectorStore.tables[kind]}`).get().n, 0);
  assert.deepEqual(result, [], 'physical deletion must also retire the already captured native result');
  const after = generationInvalidationState(f.reader, backend.vectorStore.tables);
  assert.equal(after.quarantined, false);
  assert.notEqual(after.epoch, before.epoch);
  assert.equal(borrowed.isCurrent(), false);
  f.writer.getDb().prepare('DELETE FROM message_recall_index_suppressions').run();
  await f.writer.upsert([{ ...document, title: 'Restored current title', sourceHash: 'two' }]);
  f.writer
    .getDb()
    .prepare('INSERT OR IGNORE INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)')
    .run(document.anchor, 'msg-neutral', 'Restored passage', '2026-11-09');
  const key = kind === 'documents' ? document.anchor : passageKey;
  const currentSource = captureVectorSource(f.store.getDb(), kind, key);
  assert.ok(currentSource);
  const writable = kind === 'documents' ? backend.vectorStore : backend.passageVectorStore;
  assert.equal(commitVectorSource(f.store.getDb(), writable, currentSource, unit(model.dim), model), true);
  const fresh = openVectorGeneration(f.reader, model)[kind === 'documents' ? 'vectorStore' : 'passageVectorStore'];
  assert.equal(
    fresh.search(unit(model.dim), 1).length,
    1,
    'newly projected current source remains readable without quarantine',
  );
  assert.equal(borrowed.isCurrent(), false, 're-embedding must not revive an older borrowed capability');
  assert.equal(f.store.searchEmbedding().isCurrent(), true);
}
for (const generation of [0, 1])
  for (const kind of ['documents', 'passages'])
    for (const action of ['update', 'delete', 'forget'])
      test(`healthy G${generation} ${kind} ${action} discards an in-flight native result and admits a fresh projection`, (t) =>
        staleNativeRead(t, generation, kind, action));

test('reopening an existing schema with an older fact trigger installs the current retirement behavior', (t) =>
  staleNativeRead(t, 0, 'passages', 'update', true));

for (const mode of ['semantic', 'hybrid'])
  test(`healthy real forget producer retires the in-flight ${mode} worker without cancelling its caller`, async (t) => {
    const f = await fixture(t),
      caller = new AbortController();
    let calls = 0;
    const builder = new IndexBuilder(f.writer, '/unused');
    f.store.setEmbedDeps({
      ...f.backends[0],
      mode: 'on',
      embedding: {
        load: async () => {},
        reprobeIfNeeded: async () => {},
        isReady: () => true,
        getModelInfo: () => f.models[0],
        embed: async (texts) => {
          calls++;
          const lease = await builder.suppressMessagePassage('neutral', 'neutral');
          await builder.finalizeMessagePassageSuppression(lease);
          return texts.map(() => unit(4));
        },
      },
    });
    const reply = await f.store.searchMessagePassages('Original passage', {
      visibleThreadIds: ['neutral'],
      mode,
      candidateOrder: 'relevance',
      signal: caller.signal,
      deadlineAt: Date.now() + 10000,
    });
    assert.equal(reply.meta.effectiveMode, 'lexical');
    assert.equal(reply.meta.degraded, true);
    assert.equal(reply.passages.length, 0);
    assert.equal(calls, 1);
    assert.equal(caller.signal.aborted, false);
    for (const b of f.backends)
      assert.equal(generationInvalidationState(f.reader, b.vectorStore.tables).quarantined, false);
  });
