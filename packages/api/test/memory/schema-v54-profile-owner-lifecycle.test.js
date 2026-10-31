import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';

describe('V61 Profile owner lifecycle migration (legacy V54 fixture filename)', () => {
  it('upgrades a V53 database idempotently and preserves Entity lifecycle tables', async () => {
    const { applyMigrations, CURRENT_SCHEMA_VERSION } = await import('../../dist/domains/memory/schema.js');
    const db = new Database(':memory:');
    applyMigrations(db);
    db.exec('DROP TABLE profile_memory_owner_action_evidence');
    db.prepare('DELETE FROM schema_version WHERE version >= 54').run();

    assert.doesNotThrow(() => applyMigrations(db));
    assert.doesNotThrow(() => applyMigrations(db));
    assert.equal(
      db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version,
      CURRENT_SCHEMA_VERSION,
    );
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'profile_memory_owner_action_evidence'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'entity_memory_owner_action_evidence'").get());
    db.close();
  });
});
