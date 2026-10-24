import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as yieldToIo } from 'node:timers/promises';
import * as sqliteVec from 'sqlite-vec';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { PassageVectorStore, passageVectorKey } from '../../dist/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { ensurePassageVectorTable, ensureVectorTable } from '../../dist/domains/memory/schema.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';

async function fixture(t, count = 768, missing = new Set()) {
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  t.after(() => store.close());
  const db = store.getDb();
  sqliteVec.load(db);
  ensureVectorTable(db, 4);
  ensurePassageVectorTable(db, 4);
  const passages = new PassageVectorStore(db, 4);
  await store.upsert([
    { anchor: 'warmup', kind: 'thread', status: 'active', title: 'Warmup fixture', updatedAt: '2026-10-23' },
  ]);
  const insert = db.prepare(
    'INSERT INTO evidence_passages (doc_anchor, passage_id, content, created_at) VALUES (?, ?, ?, ?)',
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      insert.run('warmup', `p${i}`, `Passage body ${i}`, '2026-10-23T00:00:00Z');
      if (!missing.has(i)) passages.upsert(passageVectorKey('warmup', `p${i}`), new Float32Array([1, 0, 0, 0]));
    }
  })();
  const embedded = [];
  const embedding = {
    isReady: () => true,
    reprobeIfNeeded: async () => {},
    getModelInfo: () => ({ modelId: 'fixture', modelRev: '1', dim: 4 }),
    embed: async (texts) => {
      embedded.push(...texts);
      return texts.map(() => new Float32Array([0, 1, 0, 0]));
    },
  };
  const builder = new IndexBuilder(store, '/unused-warmup-fixture', {
    embedding,
    vectorStore: new VectorStore(db, 4),
    passageVectorStore: passages,
  });
  let payloadReads = 0;
  db.function('observe_body_read', (body) => {
    payloadReads++;
    return body;
  });
  db.exec(`ALTER TABLE evidence_passages RENAME TO fixture_passages;
    CREATE VIEW evidence_passages AS SELECT id, doc_anchor, passage_id,
      observe_body_read(content) AS content FROM fixture_passages`);
  return { db, builder, passages, embedding, embedded, payloadReads: () => payloadReads };
}

async function warmup(builder, twice = false) {
  builder.startPassageEmbeddingWarmup();
  if (twice) builder.startPassageEmbeddingWarmup();
  await yieldToIo();
  while (builder.isPassageWarmupActive()) await yieldToIo();
}

test('overlapping warmups scan once and allow I/O before the warm scan completes', async (t) => {
  const { db, builder, embedded } = await fixture(t);
  const prepare = db.prepare.bind(db);
  let scanned = 0;
  let heartbeatAt;
  let heartbeat;
  db.prepare = (sql) => {
    const statement = prepare(sql);
    if (sql.includes('FROM evidence_passages')) {
      const all = statement.all.bind(statement);
      statement.all = (...args) => {
        const rows = all(...args);
        scanned += rows.length;
        if (rows.length && !heartbeat)
          heartbeat = yieldToIo().then(() => {
            heartbeatAt = scanned;
          });
        return rows;
      };
    }
    return statement;
  };
  await warmup(builder, true);
  await heartbeat;
  assert.equal(scanned, 768, 'overlapping warmups must share the same bounded scan');
  assert.ok(heartbeatAt > 0 && heartbeatAt < 768, `I/O ran only after ${heartbeatAt} passages were scanned`);
  assert.deepEqual(embedded, [], 'existing vectors must not be recomputed');
});

test('warmup hydrates only missing bodies and preserves existing vectors', async (t) => {
  const missing = new Set([1, 257, 767]);
  const { builder, passages, embedded, payloadReads } = await fixture(t, 768, missing);
  await warmup(builder);
  assert.deepEqual(embedded, ['Passage body 1', 'Passage body 257', 'Passage body 767']);
  assert.equal(payloadReads(), missing.size * 2, 'only missing bodies are read for embedding and the source fence');
  assert.equal(passages.count(), 768);
  const existing = passages.search(new Float32Array([1, 0, 0, 0]), 1)[0];
  assert.equal(existing.distance, 0, 'existing vector bytes must retain their meaning');
});

test('deactivating embedding stops the remaining warm scan at its next I/O turn', async (t) => {
  const { builder, passages } = await fixture(t);
  const existingKeys = passages.existingKeys.bind(passages);
  let pages = 0;
  passages.existingKeys = (keys) => {
    pages++;
    if (pages === 1) setImmediate(() => builder.setEmbedDeps(undefined));
    return existingKeys(keys);
  };
  await warmup(builder);
  assert.equal(pages, 1, 'service deactivation must stop scanning unrelated remaining pages');
  assert.equal(passages.count(), 768, 'service deactivation must retain persisted vectors');
});

for (const throws of [false, true]) {
  test(`an unavailable embedding service skips the scan (probe throws: ${throws})`, async (t) => {
    const { builder, passages, embedding, embedded, payloadReads } = await fixture(t, 3, new Set([1]));
    embedding.isReady = () => false;
    embedding.reprobeIfNeeded = async () => {
      if (throws) throw new Error('provider unavailable');
    };
    passages.existingKeys = () => {
      assert.fail('unavailable providers must not scan stored vectors');
    };
    await warmup(builder);
    assert.deepEqual(embedded, []);
    assert.equal(payloadReads(), 0);
  });
}
