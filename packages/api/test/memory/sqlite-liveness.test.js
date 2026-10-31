import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

async function fixture(t, count = 12000) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-liveness-'));
  const store = new SqliteEvidenceStore(join(dir, 'evidence.sqlite'));
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const db = store.getDb();
  db.prepare(
    `INSERT INTO evidence_docs (anchor,kind,status,title,updated_at) VALUES ('thread-large','thread','active','Large corpus','2026-01-01')`,
  ).run();
  const insert = db.prepare(
    `INSERT INTO evidence_passages (doc_anchor,passage_id,content,position,created_at) VALUES ('thread-large',?,?,?,'2026-01-01')`,
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) insert.run(`msg-${i}`, `common word 砚砚 entityA ${'filler '.repeat(120)}`, i);
  })();
  return { store, dir };
}
async function observeIo(operation) {
  let turns = 0;
  const timer = setInterval(() => {
    turns++;
  }, 5);
  try {
    const value = await operation();
    return { turns, value };
  } finally {
    clearInterval(timer);
  }
}
test('passage search keeps the API event loop responsive during native FTS', async (t) => {
  const { store } = await fixture(t);
  const { turns, value } = await observeIo(() => store.search('common', { scope: 'threads', depth: 'raw', limit: 5 }));
  assert.ok(value.length > 0);
  assert.ok(turns > 2, `health timer got ${turns} turns during full-corpus FTS`);
});
test('entity approval publishes registry and all mentions without blocking health', async (t) => {
  const { store } = await fixture(t);
  const { turns } = await observeIo(() =>
    store.upsertEntities([
      {
        entityId: 'person:example',
        type: 'person',
        canonicalName: 'Example',
        aliases: ['entityA'],
        provenance: [{ source: 'fixture' }],
        updatedAt: '2026-01-02',
      },
    ]),
  );
  const mentions = store
    .getDb()
    .prepare(`SELECT count(*) AS n FROM entity_mentions WHERE entity_id='person:example'`)
    .get();
  assert.equal(mentions.n, 12000);
  assert.ok(turns > 2, `health timer got ${turns} turns during entity projection`);
});
test('full scanner yields health requests while preserving complete index output', async (t) => {
  const { store, dir } = await fixture(t, 0);
  const docs = join(dir, 'docs');
  mkdirSync(join(docs, 'features'), { recursive: true });
  for (let i = 0; i < 600; i++)
    writeFileSync(
      join(docs, 'features', `F${i}-fixture.md`),
      `---\nfeature_ids: [F${i}]\n---\n# F${i} common\n${'Content line.\n'.repeat(60)}`,
    );
  const builder = new IndexBuilder(store, docs);
  let turnsAtScanEnd = 0;
  let turns = 0;
  const timer = setInterval(() => {
    turns++;
  }, 5);
  try {
    const result = await builder.rebuild({
      force: true,
      deferThreadIndexing: true,
      onProgress(phase, percent) {
        if (phase === 'scanning' && percent === 15) turnsAtScanEnd = turns;
      },
    });
    assert.equal(result.docsIndexed, 600);
    assert.ok(turnsAtScanEnd > 0, 'synchronous discovery starved health before scan completion');
  } finally {
    clearInterval(timer);
  }
});
