import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

describe('Schema V2 migration', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    sqliteVec.load(db);
  });

  it('applyMigrations on empty DB creates V1 + V2 tables', async () => {
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    applyMigrations(db);
    // V1 tables
    const docs = db.prepare("SELECT name FROM sqlite_master WHERE name='evidence_docs'").get();
    assert.ok(docs, 'evidence_docs should exist');
    // V2 tables
    const meta = db.prepare("SELECT name FROM sqlite_master WHERE name='embedding_meta'").get();
    assert.ok(meta, 'embedding_meta table should exist');
  });

  it('V2 migration does NOT create evidence_vectors (decoupled)', async () => {
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    applyMigrations(db);
    const row = db.prepare("SELECT name FROM sqlite_master WHERE name='evidence_vectors'").get();
    assert.equal(row, undefined, 'evidence_vectors should NOT be created by migration');
  });

  it('ensureVectorTable creates vec0 table when extension loaded', async () => {
    const { applyMigrations, ensureVectorTable } = await import('../../dist/domains/memory/schema.js');
    applyMigrations(db);
    const ok = ensureVectorTable(db, 256);
    assert.equal(ok, true);
    const row = db.prepare("SELECT name FROM sqlite_master WHERE name='evidence_vectors'").get();
    assert.ok(row);
  });

  it('ensureVectorTable returns false without extension', async () => {
    const { applyMigrations, ensureVectorTable } = await import('../../dist/domains/memory/schema.js');
    const plainDb = new Database(':memory:');
    applyMigrations(plainDb);
    const ok = ensureVectorTable(plainDb, 256);
    assert.equal(ok, false);
  });

  it('ensureVectorTable is idempotent', async () => {
    const { applyMigrations, ensureVectorTable } = await import('../../dist/domains/memory/schema.js');
    applyMigrations(db);
    ensureVectorTable(db, 256);
    ensureVectorTable(db, 256); // second call — no error
  });

  it('migration is idempotent (running twice does not error)', async () => {
    const { applyMigrations, CURRENT_SCHEMA_VERSION } = await import('../../dist/domains/memory/schema.js');
    applyMigrations(db);
    applyMigrations(db);
    const version = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
    assert.equal(
      version.v,
      CURRENT_SCHEMA_VERSION,
      `schema version should be ${CURRENT_SCHEMA_VERSION}, got ${version.v}`,
    );
  });

  it('schema_version table is created even on empty DB (P1 fix)', async () => {
    const { applyMigrations, CURRENT_SCHEMA_VERSION } = await import('../../dist/domains/memory/schema.js');
    const freshDb = new Database(':memory:');
    // This should NOT throw "no such table: schema_version"
    applyMigrations(freshDb);
    const version = freshDb.prepare('SELECT MAX(version) as v FROM schema_version').get();
    assert.equal(
      version.v,
      CURRENT_SCHEMA_VERSION,
      `schema version should be ${CURRENT_SCHEMA_VERSION}, got ${version.v}`,
    );
  });

  it('CURRENT_SCHEMA_VERSION matches expected value', async () => {
    const { CURRENT_SCHEMA_VERSION } = await import('../../dist/domains/memory/schema.js');
    assert.equal(CURRENT_SCHEMA_VERSION, 15, `expected 15, got ${CURRENT_SCHEMA_VERSION}`);
  });
});
