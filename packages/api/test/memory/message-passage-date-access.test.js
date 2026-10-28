import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { lexicalMessagePassages } from '../../dist/domains/memory/message-passage-lexical.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

const lower = '2026-10-27T01:17:00.000Z';
const upper = '2026-10-27T01:26:00.000Z';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'message-date-access-'));
  const path = join(root, 'fixture.sqlite');
  const store = new SqliteEvidenceStore(path);
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  await store.upsert([
    { anchor: 'thread-visible', kind: 'thread', status: 'active', title: 'neutral', updatedAt: lower },
  ]);
  const db = store.getDb();
  const insert = db.prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)');
  db.transaction(() => {
    for (let i = 0; i < 64; i++)
      insert.run('thread-visible', `msg-old-${i}`, 'historical ' + 'x'.repeat(16384), '2020-01-01T00:00:00.000Z');
    for (let i = 0; i < 17; i++)
      insert.run('thread-visible', `msg-current-${String(i).padStart(2, '0')}`, '目标词', lower);
    insert.run('thread-visible', 'msg-question', '目标词', lower);
  })();
  return { store, path };
}

function queryAndPlan(db, sort, dates = { dateFrom: lower, dateTo: upper }) {
  const original = db.prepare;
  let sql;
  let bindings;
  db.prepare = function (text) {
    const statement = original.call(this, text);
    if (text.includes('message_cjk_match')) {
      sql = text;
      const all = statement.all;
      statement.all = function (...args) {
        bindings = args;
        return all.apply(this, args);
      };
    }
    return statement;
  };
  let rows;
  try {
    rows = lexicalMessagePassages(
      db,
      '目标词',
      {
        sort,
        ...dates,
        excludeSource: { threadId: 'visible', messageId: 'question' },
      },
      new Set(['thread-visible']),
      2000,
    );
  } finally {
    db.prepare = original;
  }
  return {
    rows,
    plan: db
      .prepare('EXPLAIN QUERY PLAN ' + sql)
      .all(...bindings)
      .map((row) => row.detail),
  };
}

for (const sort of ['time', 'relevance']) {
  test(`date-bounded ${sort} read seeks a native date range instead of historical wide rows`, async (t) => {
    const { store } = await fixture(t);
    const { rows, plan } = queryAndPlan(store.getDb(), sort);
    assert.deepEqual(
      rows.map((row) => row.passageId),
      Array.from({ length: 17 }, (_, i) => `msg-current-${String(i).padStart(2, '0')}`),
    );
    assert.ok(
      plan.some((detail) => detail.includes('created_at>?') && detail.includes('created_at<?')),
      JSON.stringify(plan),
    );
    const noDate = queryAndPlan(store.getDb(), sort, {});
    assert.deepEqual(
      noDate.rows.map((row) => row.passageId),
      rows.map((row) => row.passageId),
    );
    assert.ok(
      noDate.plan.some((detail) => detail.includes('doc_anchor=?')),
      JSON.stringify(noDate.plan),
    );
  });
}

test('a legacy file remains readable without migrating in the worker, then gains date access on writer upgrade', async (t) => {
  const { store, path } = await fixture(t);
  const db = store.getDb();
  db.exec('DROP INDEX IF EXISTS idx_message_passage_date');
  db.prepare('DELETE FROM schema_version WHERE version=73').run();
  store.close();
  const legacyReader = new SqliteEvidenceStore(path, undefined, { workerMode: 'read' });
  await legacyReader.initialize();
  try {
    const before = queryAndPlan(legacyReader.getDb(), 'time');
    assert.equal(before.rows.length, 17);
    assert.equal(
      before.plan.some((detail) => detail.includes('created_at>?')),
      false,
    );
    assert.equal(legacyReader.getDb().prepare('SELECT 1 FROM schema_version WHERE version=73').get(), undefined);
  } finally {
    legacyReader.close();
  }
  await store.initialize();
  const snapshots = [];
  const published = await store.searchMessagePassages('目标词', {
    visibleThreadIds: ['visible'],
    mode: 'lexical',
    sort: 'time',
    dateFrom: lower,
    dateTo: upper,
    excludeSource: { threadId: 'visible', messageId: 'question' },
    deadlineAt: Date.now() + 15_000,
    onReadSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  assert.deepEqual(
    published.passages.map((row) => row.passageId),
    Array.from({ length: 17 }, (_, i) => `msg-current-${String(i).padStart(2, '0')}`),
  );
  assert.equal(snapshots.at(-1).outcome, 'fulfilled');
  store.close();
  const reader = new SqliteEvidenceStore(path, undefined, { workerMode: 'read' });
  await reader.initialize();
  try {
    const after = queryAndPlan(reader.getDb(), 'time');
    assert.equal(after.rows.length, 17);
    assert.ok(
      after.plan.some((detail) => detail.includes('created_at>?') && detail.includes('created_at<?')),
      JSON.stringify(after.plan),
    );
  } finally {
    reader.close();
  }
});

test('an interrupted version stamp rolls back the new index and can retry without changing passages', async (t) => {
  const { store } = await fixture(t);
  const db = store.getDb();
  db.exec('DROP INDEX IF EXISTS idx_message_passage_date');
  db.prepare('DELETE FROM schema_version WHERE version=73').run();
  const before = queryAndPlan(db, 'time').rows;
  db.exec(`CREATE TRIGGER reject_date_upgrade BEFORE INSERT ON schema_version
    WHEN NEW.version=73 BEGIN SELECT RAISE(ABORT, 'controlled date upgrade failure'); END`);
  assert.throws(() => applyMigrations(db), /controlled date upgrade failure/);
  assert.equal(db.prepare('SELECT 1 FROM schema_version WHERE version=73').get(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_message_passage_date'").get(), undefined);
  assert.deepEqual(queryAndPlan(db, 'time').rows, before);
  db.exec('DROP TRIGGER reject_date_upgrade');
  applyMigrations(db);
  const retried = queryAndPlan(db, 'time');
  assert.deepEqual(retried.rows, before);
  assert.ok(retried.plan.some((detail) => detail.includes('created_at>?') && detail.includes('created_at<?')));
});
