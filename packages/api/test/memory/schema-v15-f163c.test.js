/**
 * F163 Phase C Task 1: Schema V15 — contradiction + review columns
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations, CURRENT_SCHEMA_VERSION } from '../../dist/domains/memory/schema.js';

describe('Schema V15 (F163 Phase C)', () => {
  it('CURRENT_SCHEMA_VERSION is 15', () => {
    assert.equal(CURRENT_SCHEMA_VERSION, 15);
  });

  it('migration adds contradicts, invalid_at, review_cycle_days columns', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info('evidence_docs')").all();
    const names = cols.map((c) => c.name);
    assert.ok(names.includes('contradicts'), 'should have contradicts');
    assert.ok(names.includes('invalid_at'), 'should have invalid_at');
    assert.ok(names.includes('review_cycle_days'), 'should have review_cycle_days');
    const ver = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
    assert.equal(ver.v, 15);
  });
});
