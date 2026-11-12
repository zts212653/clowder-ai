import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openVectorGeneration } from '../../dist/domains/memory/open-vector-generation.js';
import { passageVectorKey } from '../../dist/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { captureVectorSource, commitVectorSource } from '../../dist/domains/memory/vector-source-binding.js';

// sqlite-vec plans a primary-key point lookup as idxNum 1; idxNum 0 is a full table scan.
// The physical invalidation triggers run once per changed canonical row on the API writer,
// so a full scan there costs (changed rows x stored vectors) on the main thread.
const FULL_SCAN = /VIRTUAL TABLE INDEX 0:/;
const unit = (dim) => Float32Array.from({ length: dim }, (_, i) => Number(i === 0));
const docs = [
  { anchor: 'thread-a', passages: ['a-1', 'a-2', 'a-3'] },
  { anchor: 'thread-b', passages: ['b-1'] },
];

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'generation-point-delete-'));
  const path = join(root, 'evidence.sqlite');
  const store = new SqliteEvidenceStore(path);
  await store.initialize();
  await store.upsert(
    docs.map(({ anchor }) => ({
      anchor,
      title: anchor,
      summary: 'Body',
      kind: 'thread',
      status: 'active',
      sourceHash: 'one',
      updatedAt: '2026-11-10',
    })),
  );
  const insert = store
    .getDb()
    .prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)');
  for (const { anchor, passages } of docs)
    for (const id of passages) insert.run(anchor, id, `Passage ${id}`, '2026-11-10');
  const models = [
    { modelId: 'g0-fixture', modelRev: '1', dim: 4, generationId: 'g0' },
    { modelId: 'g1-fixture', modelRev: '1', dim: 6, generationId: 'g1', representationFingerprint: 'b'.repeat(64) },
  ];
  const backends = models.map((model) => {
    const backend = openVectorGeneration(store.getDb(), model, { create: true });
    backend.vectorStore.initMeta(model);
    if (model.generationId === 'g1')
      store
        .getDb()
        .prepare("INSERT INTO vector_generations VALUES('g1',?,'ready')")
        .run(model.representationFingerprint);
    for (const { anchor, passages } of docs) {
      const targets = [
        ['documents', anchor, backend.vectorStore],
        ...passages.map((id) => ['passages', passageVectorKey(anchor, id), backend.passageVectorStore]),
      ];
      for (const [kind, key, target] of targets)
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
    }
    return backend;
  });
  // A fresh canonical writer installs the native TEMP triggers against existing vec0 tables.
  const writer = new SqliteEvidenceStore(path);
  await writer.initialize();
  t.after(() => {
    writer.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { writer: writer.getDb(), tables: backends.map((backend) => backend.vectorStore.tables) };
}

function vectorKeys(db, table, column) {
  return db
    .prepare(`SELECT ${column} AS key FROM ${table}`)
    .all()
    .map((row) => row.key)
    .sort();
}

function triggerStatements(db) {
  const vec0 = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%USING vec0%'")
    .all()
    .map((row) => row.name);
  const statements = [];
  for (const { name, sql } of db.prepare("SELECT name,sql FROM sqlite_temp_master WHERE type='trigger'").all()) {
    const body = sql.slice(sql.search(/\bBEGIN\b/) + 'BEGIN'.length, sql.lastIndexOf('END'));
    for (const statement of body.split(';').map((part) => part.trim())) {
      const target = vec0.find((table) => new RegExp(`\\b${table}\\b`).test(statement));
      if (target) statements.push({ trigger: name, target, statement });
    }
  }
  return statements;
}

test('every native invalidation trigger removes vectors by primary-key point lookup', async (t) => {
  const { writer } = await fixture(t);
  const statements = triggerStatements(writer);
  const triggers = new Set(statements.map((entry) => entry.trigger));
  for (const required of [
    'vector_g0_documents_physical_UPDATE',
    'vector_g0_passages_physical_UPDATE',
    'vector_g1_passages_physical_UPDATE',
  ])
    assert.ok(triggers.has(required), `${required} must touch its vec0 table`);
  const fullScans = statements.flatMap(({ trigger, target, statement }) => {
    // Trigger row references become literals so the exact body can be planned on its own.
    const planned = statement.replace(/\b(old|new)\.\w+/g, "'probe'");
    const plan = writer
      .prepare(`EXPLAIN QUERY PLAN ${planned}`)
      .all()
      .map((row) => row.detail);
    return plan.some((detail) => detail.includes(target) && FULL_SCAN.test(detail))
      ? [`${trigger}: ${statement} -> ${plan.join(' | ')}`]
      : [];
  });
  assert.deepEqual(fullScans, []);
});

test('parent document changes still remove exactly that document passage vectors', async (t) => {
  for (const change of [
    "DELETE FROM evidence_docs WHERE anchor='thread-a'",
    "UPDATE evidence_docs SET status='archived' WHERE anchor='thread-a'",
  ]) {
    await t.test(change, async (t) => {
      const { writer, tables } = await fixture(t);
      writer.exec(change);
      for (const names of tables)
        assert.deepEqual(vectorKeys(writer, names.passages, 'passage_key'), [passageVectorKey('thread-b', 'b-1')]);
    });
  }
});

test('row changes remove only their own vectors', async (t) => {
  const { writer, tables } = await fixture(t);
  writer.exec("UPDATE evidence_passages SET content='Changed' WHERE doc_anchor='thread-a' AND passage_id='a-2'");
  writer.exec("UPDATE evidence_docs SET title='Renamed' WHERE anchor='thread-b'");
  for (const names of tables) {
    assert.deepEqual(
      vectorKeys(writer, names.passages, 'passage_key'),
      [
        passageVectorKey('thread-a', 'a-1'),
        passageVectorKey('thread-a', 'a-3'),
        passageVectorKey('thread-b', 'b-1'),
      ].sort(),
    );
    assert.deepEqual(vectorKeys(writer, names.documents, 'anchor'), ['thread-a']);
  }
});
