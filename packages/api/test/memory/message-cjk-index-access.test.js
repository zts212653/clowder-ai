import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { lexicalMessagePassages } from '../../dist/domains/memory/message-passage-lexical.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

const needle = '甲乙丙丁戊己庚辛';
async function fixture(t, file = false, count = 8193) {
  const root = mkdtempSync(join(tmpdir(), 'cjk-index-access-'));
  const path = file ? join(root, 'evidence.sqlite') : ':memory:';
  const store = new SqliteEvidenceStore(path);
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const db = store.getDb();
  db.exec(
    "INSERT INTO evidence_docs(anchor,kind,status,title,updated_at) VALUES('thread-visible','thread','active','test','2026-01-01'),('thread-denied','thread','active','test','2026-01-01')",
  );
  const put = db.prepare(
    "INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,'2026-01-01')",
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) put.run('thread-visible', `msg-noise-${i}`, '中性正文');
  })();
  return { store, db, path, put: (id, body, anchor = 'thread-visible') => put.run(anchor, id, body) };
}
const read = (db, query = needle) =>
  lexicalMessagePassages(db, query, { sort: 'relevance' }, new Set(['thread-visible']), 20);
const ids = (rows) => rows.map((r) => r.passageId).sort();

test('a complete canonical index seeks matching message bodies instead of walking every admitted body', async (t) => {
  const { db, put } = await fixture(t);
  put('msg-late', `前${needle}后`);
  const original = db.prepare;
  let bodyPlan;
  db.prepare = function (sql) {
    const statement = original.call(this, sql);
    if (!sql.includes('message_cjk_match')) return statement;
    const all = statement.all;
    statement.all = (...bindings) => {
      bodyPlan = original.call(db, `EXPLAIN QUERY PLAN ${sql}`).all(...bindings);
      return all.call(statement, ...bindings);
    };
    return statement;
  };
  try {
    assert.deepEqual(ids(read(db)), ['msg-late']);
  } finally {
    db.prepare = original;
  }
  // Rowid point lookup is the observable access property. A source-index
  // range still visits all bodies in every admitted thread and is insufficient.
  assert.ok(
    bodyPlan.some((r) => /SEARCH p USING INTEGER PRIMARY KEY/.test(r.detail)),
    JSON.stringify(bodyPlan),
  );
});

test('full membership survives unicode61 token truncation, NULs and false prefix candidates', async (t) => {
  const { db, put } = await fixture(t);
  put('msg-after-token-limit', `${'中'.repeat(30000)}${needle}终`);
  put('msg-before-token-limit', `${needle}${'中'.repeat(30000)}`);
  put('msg-after-nul', `前\0${needle}后`);
  put('msg-prefix-only', '甲乙丙丁戊己庚辛替换');
  put('msg-denied', `${needle}后`, 'thread-denied');
  assert.deepEqual(ids(read(db, `${needle}终 ${needle}后`)), ['msg-after-nul', 'msg-after-token-limit']);
});

test('missing FTS rows remain recoverable without losing full-query order', async (t) => {
  const { db, put } = await fixture(t);
  put('msg-indexed', `长前缀${needle}后`);
  put('msg-unindexed', needle);
  const row = db.prepare("SELECT rowid,content FROM evidence_passages WHERE passage_id='msg-unindexed'").get();
  db.prepare("INSERT INTO passage_fts(passage_fts,rowid,content) VALUES('delete',?,?)").run(row.rowid, row.content);
  assert.deepEqual(
    read(db).map((r) => r.passageId),
    ['msg-unindexed', 'msg-indexed'],
  );
});

test('an unmaintained FTS layout retains the canonical literal scan', async (t) => {
  const { db, put } = await fixture(t);
  put('msg-changed', '旧正文');
  db.exec('DROP TRIGGER evidence_passages_au');
  db.prepare("UPDATE evidence_passages SET content=? WHERE passage_id='msg-changed'").run(`前${needle}后`);
  assert.deepEqual(ids(read(db)), ['msg-changed']);
});

test('a live readonly connection follows canonical inserts, updates and deletion', async (t) => {
  const { db, put, path } = await fixture(t, true);
  put('msg-before', `前${needle}后`);
  const reader = new SqliteEvidenceStore(path, undefined, { workerMode: 'read' });
  await reader.initialize();
  t.after(() => reader.close());
  assert.deepEqual(ids(read(reader.getDb())), ['msg-before']);
  db.prepare("UPDATE evidence_passages SET content='已修改' WHERE passage_id='msg-before'").run();
  put('msg-new', `${needle}后`);
  assert.deepEqual(ids(read(reader.getDb())), ['msg-new']);
  db.prepare("DELETE FROM evidence_passages WHERE passage_id='msg-new'").run();
  assert.deepEqual(ids(read(reader.getDb())), []);
});

test('a small admitted source range does not scan the global token vocabulary', async (t) => {
  const { db, put } = await fixture(t, false, 512);
  put('msg-small', `前${needle}后`);
  const original = db.prepare;
  let bodyPlan;
  db.prepare = function (sql) {
    const statement = original.call(this, sql);
    if (!sql.includes('message_cjk_match')) return statement;
    const all = statement.all;
    statement.all = (...bindings) => {
      bodyPlan = original.call(db, `EXPLAIN QUERY PLAN ${sql}`).all(...bindings);
      return all.call(statement, ...bindings);
    };
    return statement;
  };
  try {
    assert.deepEqual(ids(read(db)), ['msg-small']);
  } finally {
    db.prepare = original;
  }
  assert.ok(!bodyPlan.some((r) => /VIRTUAL TABLE/.test(r.detail)), JSON.stringify(bodyPlan));
});
