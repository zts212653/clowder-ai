import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';

describe('V60 Entity owner lifecycle migration (legacy V53 fixture filename)', () => {
  it('upgrades a V52 database idempotently without rewriting canonical entities', async () => {
    const { applyMigrations, CURRENT_SCHEMA_VERSION } = await import('../../dist/domains/memory/schema.js');
    const { EntityRegistryStore } = await import('../../dist/domains/memory/EntityRegistry.js');
    const db = new Database(':memory:');
    applyMigrations(db);
    const registry = new EntityRegistryStore(db);
    registry.upsert(
      [
        {
          entityId: 'concept:pre-v53',
          type: 'concept',
          canonicalName: 'Pre V53',
          aliases: ['pre-v53'],
          provenance: [{ source: 'fixture' }],
          updatedAt: '2026-10-06T00:00:00.000Z',
        },
      ],
      { source: 'system' },
    );
    db.exec('DROP TABLE entity_memory_owner_action_evidence; DROP TABLE entity_memory_forget_tombstones;');
    db.prepare('DELETE FROM schema_version WHERE version >= 53').run();

    assert.doesNotThrow(() => applyMigrations(db));
    assert.doesNotThrow(() => applyMigrations(db));
    assert.equal(
      db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version,
      CURRENT_SCHEMA_VERSION,
    );
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'entity_memory_forget_tombstones'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'entity_memory_owner_action_evidence'").get());
    assert.equal(registry.get('concept:pre-v53').canonicalName, 'Pre V53');
    db.close();
  });
});
