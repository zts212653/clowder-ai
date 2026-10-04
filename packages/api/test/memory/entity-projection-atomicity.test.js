import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { migrateEntityMentionProjections } from '../../dist/domains/memory/entity-mention-projection-schema.js';
import { recoverEntityMentionProjections } from '../../dist/domains/memory/publish-entity-mentions.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

function legacyFixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT); INSERT INTO schema_version VALUES(51,'fixture');
    CREATE TABLE entity_registry(entity_id TEXT PRIMARY KEY); INSERT INTO entity_registry VALUES('e');
    CREATE TABLE entity_aliases(entity_id TEXT, alias TEXT);
    CREATE TABLE evidence_docs(anchor TEXT PRIMARY KEY); INSERT INTO evidence_docs VALUES('d');
    CREATE TABLE evidence_passages(id INTEGER PRIMARY KEY);
    CREATE TABLE entity_mentions(entity_id TEXT, doc_anchor TEXT, passage_id TEXT DEFAULT '', surface TEXT, surface_norm TEXT, source TEXT, provenance_json TEXT, created_at TEXT,
      PRIMARY KEY(entity_id,doc_anchor,passage_id,surface_norm), FOREIGN KEY(entity_id) REFERENCES entity_registry(entity_id) ON DELETE CASCADE, FOREIGN KEY(doc_anchor) REFERENCES evidence_docs(anchor) ON DELETE CASCADE);
    INSERT INTO entity_mentions VALUES('e','d','p','old','old','passage','[]','fixture');`);
  return db;
}
test('V52 retains legacy rows and supports the older writer INSERT OR IGNORE / DELETE contract', () => {
  const db = legacyFixture();
  try {
    migrateEntityMentionProjections(db);
    assert.equal(db.prepare('SELECT count(*) AS n FROM entity_mentions').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM entity_mentions_legacy').get().n, 1);
    db.exec(`INSERT OR IGNORE INTO entity_mentions VALUES('e','d','p2','new','new','passage','[]','fixture');
      INSERT OR IGNORE INTO entity_mentions VALUES('e','d','p2','new','new','passage','[]','fixture');`);
    assert.equal(db.prepare('SELECT count(*) AS n FROM entity_mentions').get().n, 2);
    db.exec(`INSERT INTO entity_mention_entity_heads VALUES('e',1);
      INSERT OR IGNORE INTO entity_mentions VALUES('e','d','p3','current','current','passage','[]','fixture')`);
    assert.deepEqual(db.prepare('SELECT passage_id FROM entity_mentions').all(), [{ passage_id: 'p3' }]);
    db.exec(`DELETE FROM entity_mentions WHERE entity_id='e'`);
    assert.equal(db.prepare('SELECT count(*) AS n FROM entity_mentions').get().n, 0);
    assert.throws(
      () => db.exec(`INSERT INTO entity_mentions VALUES('missing','d','p','x','x','passage','[]','fixture')`),
      /FOREIGN KEY/,
    );
  } finally {
    db.close();
  }
});
test('a migration error rolls back rename, new tables and version together', () => {
  const db = legacyFixture();
  try {
    const original = db.exec;
    db.exec = function (sql) {
      if (sql.includes('CREATE TRIGGER IF NOT EXISTS memory_revision_evidence_docs_insert'))
        throw new Error('injected late DDL failure');
      return original.call(this, sql);
    };
    assert.throws(() => migrateEntityMentionProjections(db), /injected late DDL failure/);
    db.exec = original;
    assert.equal(db.prepare('SELECT count(*) AS n FROM entity_mentions').get().n, 1);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_source_revision'").get(), undefined);
    assert.deepEqual(db.prepare("SELECT type FROM sqlite_master WHERE name='entity_mentions'").get(), {
      type: 'table',
    });
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='entity_mentions_legacy'").get(), undefined);
    assert.equal(db.prepare('SELECT max(version) AS version FROM schema_version').get().version, 51);
  } finally {
    db.close();
  }
});
test('partial staging is invisible and changed source revision cannot publish stale mentions', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'entity-fence-'));
  const store = new SqliteEvidenceStore(join(dir, 'evidence.sqlite'));
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await store.upsert([{ anchor: 'd', kind: 'feature', status: 'active', title: 'old new', updatedAt: '2026-01-01' }]);
  const entity = {
    entityId: 'person:e',
    type: 'person',
    canonicalName: 'Fixture',
    aliases: ['old'],
    provenance: [{ source: 'fixture' }],
    updatedAt: '2026-01-01',
  };
  await store.upsertEntities([entity]);
  const db = store.getDb();
  let injected = false;
  let visibleSurfaces = [];
  const events = channel('cat-cafe.entity-mention-projection');
  const subscriber = (message) => {
    if (message.phase !== 'staging' || injected) return;
    injected = true;
    visibleSurfaces = db.prepare('SELECT surface FROM entity_mentions').all();
    db.prepare("UPDATE evidence_docs SET title='changed source' WHERE anchor='d'").run();
  };
  events.subscribe(subscriber);
  try {
    await assert.rejects(store.upsertEntities([{ ...entity, aliases: ['new'] }]), /source revision changed/);
  } finally {
    events.unsubscribe(subscriber);
  }
  assert.ok(injected);
  assert.deepEqual(visibleSurfaces, [{ surface: 'old' }]);
  assert.deepEqual((await store.getEntity(entity.entityId))?.aliases, ['old']);
  assert.deepEqual(db.prepare('SELECT surface FROM entity_mentions').all(), [{ surface: 'old' }]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM entity_mention_generations').get().n, 0);
});
test('restart cleanup discards unpublished generations and retains the published projection', async () => {
  const db = legacyFixture();
  migrateEntityMentionProjections(db);
  try {
    db.exec(`INSERT INTO entity_mention_generations VALUES(7,2147483647,'staging','{}');
      INSERT INTO entity_mention_rows VALUES(7,'e','d','bad','hidden','hidden','passage','[]','fixture');`);
    await recoverEntityMentionProjections(db);
    assert.equal(db.prepare('SELECT count(*) AS n FROM entity_mention_rows').get().n, 0);
    db.prepare('INSERT INTO entity_mention_generations VALUES(8,2147483647,?,?)').run(
      'published',
      JSON.stringify({ entityIds: ['e'], changed: true, sourceRevision: 0 }),
    );
    db.exec(
      `INSERT INTO entity_mention_rows VALUES(8,'e','d','good','published','published','passage','[]','fixture'); INSERT INTO entity_mention_entity_heads VALUES('e',8)`,
    );
    await recoverEntityMentionProjections(db);
    assert.deepEqual(db.prepare('SELECT passage_id FROM entity_mentions').all(), [{ passage_id: 'good' }]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM entity_mentions_legacy').get().n, 0);
  } finally {
    db.close();
  }
});
test('interrupted document indexing persists pending mention publication across reopen', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'entity-pending-'));
  const path = join(dir, 'evidence.sqlite');
  let store = new SqliteEvidenceStore(path);
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const doc = {
    anchor: 'd',
    kind: 'feature',
    status: 'active',
    title: 'before',
    updatedAt: '2026-01-01',
  };
  await store.upsert([doc]);
  await store.upsertEntities([
    {
      entityId: 'person:e',
      type: 'person',
      canonicalName: 'Fixture',
      aliases: ['after'],
      provenance: [{ source: 'fixture' }],
      updatedAt: '2026-01-01',
    },
  ]);
  await store.upsertForDocumentIndex({ ...doc, title: 'intermediate' });
  // The outer upsert conflict policy must not turn a repeated dirty marker into a failure.
  await store.upsertForDocumentIndex({ ...doc, title: 'after' });
  assert.equal(store.getDb().prepare('SELECT count(*) AS n FROM entity_mention_pending_docs').get().n, 1);
  store.close();
  store = new SqliteEvidenceStore(path);
  await store.initialize();
  assert.deepEqual(store.getDb().prepare('SELECT surface FROM entity_mentions').all(), [{ surface: 'after' }]);
  assert.equal(store.getDb().prepare('SELECT count(*) AS n FROM entity_mention_pending_docs').get().n, 0);
});
