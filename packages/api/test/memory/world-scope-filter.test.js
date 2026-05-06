import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations, CURRENT_SCHEMA_VERSION } from '../../dist/domains/memory/schema.js';

describe('Schema V16 (F093 world scope)', () => {
  it('CURRENT_SCHEMA_VERSION is 18', () => {
    assert.equal(CURRENT_SCHEMA_VERSION, 18);
  });

  it('migration adds world_id and scene_id columns', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info('evidence_docs')").all();
    const names = cols.map((c) => c.name);
    assert.ok(names.includes('world_id'), 'should have world_id');
    assert.ok(names.includes('scene_id'), 'should have scene_id');
    db.close();
  });

  it('creates indexes for world scope', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all();
    const names = indexes.map((i) => i.name);
    assert.ok(names.includes('idx_evidence_docs_world'), 'should have world index');
    assert.ok(names.includes('idx_evidence_docs_world_scene'), 'should have world+scene index');
    db.close();
  });

  it('existing docs without worldId still work', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at)
       VALUES ('test-1', 'feature', 'active', 'Test', '2026-04-30')`,
    ).run();
    const row = db.prepare('SELECT world_id, scene_id FROM evidence_docs WHERE anchor = ?').get('test-1');
    assert.equal(row.world_id, null, 'world_id should be null for non-world docs');
    assert.equal(row.scene_id, null, 'scene_id should be null for non-world docs');
    db.close();
  });
});
