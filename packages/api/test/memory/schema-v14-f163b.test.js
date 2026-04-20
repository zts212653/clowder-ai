/**
 * F163 Phase B: Schema V14 — source_ids + summary_of_anchor + compression_rationale
 * Tests that migration V14 correctly adds the three new columns to evidence_docs.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations, CURRENT_SCHEMA_VERSION } from '../../dist/domains/memory/schema.js';

describe('Schema V14 — F163 Phase B compression columns', () => {
  it('CURRENT_SCHEMA_VERSION is at least 14', () => {
    assert.ok(CURRENT_SCHEMA_VERSION >= 14, `expected >=14, got ${CURRENT_SCHEMA_VERSION}`);
  });

  it('migration adds source_ids column', () => {
    const db = new Database(':memory:');
    applyMigrations(db);

    // Insert a doc with source_ids
    db.prepare(
      'INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, source_ids) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('test-summary', 'lesson', 'active', 'Test Summary', '2026-04-16', '["LL-001","LL-003"]');

    const row = db.prepare("SELECT source_ids FROM evidence_docs WHERE anchor = 'test-summary'").get();
    assert.equal(row.source_ids, '["LL-001","LL-003"]');
  });

  it('migration adds summary_of_anchor column', () => {
    const db = new Database(':memory:');
    applyMigrations(db);

    db.prepare(
      'INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, summary_of_anchor) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('test-summary-2', 'lesson', 'active', 'Test', '2026-04-16', 'summary-group-001');

    const row = db.prepare("SELECT summary_of_anchor FROM evidence_docs WHERE anchor = 'test-summary-2'").get();
    assert.equal(row.summary_of_anchor, 'summary-group-001');
  });

  it('migration adds compression_rationale column', () => {
    const db = new Database(':memory:');
    applyMigrations(db);

    db.prepare(
      'INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, compression_rationale) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('test-summary-3', 'lesson', 'active', 'Test', '2026-04-16', 'Three docs about Redis keyPrefix merged');

    const row = db.prepare("SELECT compression_rationale FROM evidence_docs WHERE anchor = 'test-summary-3'").get();
    assert.equal(row.compression_rationale, 'Three docs about Redis keyPrefix merged');
  });

  it('new columns default to NULL', () => {
    const db = new Database(':memory:');
    applyMigrations(db);

    db.prepare('INSERT INTO evidence_docs (anchor, kind, status, title, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      'plain-doc',
      'lesson',
      'active',
      'Plain',
      '2026-04-16',
    );

    const row = db
      .prepare(
        "SELECT source_ids, summary_of_anchor, compression_rationale FROM evidence_docs WHERE anchor = 'plain-doc'",
      )
      .get();
    assert.equal(row.source_ids, null);
    assert.equal(row.summary_of_anchor, null);
    assert.equal(row.compression_rationale, null);
  });

  it('schema_version records V14', () => {
    const db = new Database(':memory:');
    applyMigrations(db);

    const row = db.prepare('SELECT version FROM schema_version WHERE version = 14').get();
    assert.ok(row, 'V14 should be recorded in schema_version');
    assert.equal(row.version, 14);
  });

  it('V14 migration is idempotent (applied on already-migrated DB)', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    // Apply again — should not throw
    assert.doesNotThrow(() => applyMigrations(db));
  });
});
