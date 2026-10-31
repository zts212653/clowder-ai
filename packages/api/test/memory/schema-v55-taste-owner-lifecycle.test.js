import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';

describe('V62 Taste owner lifecycle migration (legacy V55 fixture filename)', () => {
  it('upgrades a V54 database idempotently and preserves earlier lifecycle tables', async () => {
    const { applyMigrations, CURRENT_SCHEMA_VERSION } = await import('../../dist/domains/memory/schema.js');
    const db = new Database(':memory:');
    applyMigrations(db);
    db.exec('DROP TABLE taste_memory_lifecycle');
    db.exec('DROP TABLE taste_memory_owner_action_evidence');
    db.exec('DROP TABLE taste_takeaway_candidates');
    db.prepare('DELETE FROM schema_version WHERE version >= 55').run();

    assert.doesNotThrow(() => applyMigrations(db));
    assert.doesNotThrow(() => applyMigrations(db));
    assert.equal(
      db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version,
      CURRENT_SCHEMA_VERSION,
    );
    for (const table of [
      'taste_memory_lifecycle',
      'taste_memory_owner_action_evidence',
      'taste_takeaway_candidates',
      'profile_memory_owner_action_evidence',
      'entity_memory_owner_action_evidence',
    ]) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
    }
    db.close();
  });
});
