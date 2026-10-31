import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('V21 migration — global_ctr_baseline + first_indexed_at + shadow_ranking_json', () => {
  let Database, applyMigrations, SCHEMA_V1;

  it('V21 creates global_ctr_baseline table with correct columns', async () => {
    Database = (await import('better-sqlite3')).default;
    const schema = await import('../../dist/domains/memory/schema.js');
    applyMigrations = schema.applyMigrations;
    SCHEMA_V1 = schema.SCHEMA_V1;

    const db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    applyMigrations(db);

    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='global_ctr_baseline'").get();
    assert.ok(table, 'global_ctr_baseline table should exist');

    const cols = db.prepare('PRAGMA table_info(global_ctr_baseline)').all();
    const colNames = cols.map((c) => c.name);
    assert.ok(colNames.includes('doc_kind'), 'should have doc_kind column');
    assert.ok(colNames.includes('mean_ctr'), 'should have mean_ctr column');
    assert.ok(colNames.includes('sample_count'), 'should have sample_count column');
    assert.ok(colNames.includes('updated_at'), 'should have updated_at column');
  });

  it('V21 adds first_indexed_at to evidence_docs', async () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    applyMigrations(db);

    const cols = db.prepare('PRAGMA table_info(evidence_docs)').all();
    const colNames = cols.map((c) => c.name);
    assert.ok(colNames.includes('first_indexed_at'), 'evidence_docs should have first_indexed_at');
  });

  it('V21 adds shadow_ranking_json to recall_events', async () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    applyMigrations(db);

    const cols = db.prepare('PRAGMA table_info(recall_events)').all();
    const colNames = cols.map((c) => c.name);
    assert.ok(colNames.includes('shadow_ranking_json'), 'recall_events should have shadow_ranking_json');
  });

  it('V21 schema version recorded', async () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    applyMigrations(db);

    const v = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
    assert.ok(v.v >= 21, `schema version should be >= 21, got ${v.v}`);
  });
});
