import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';

describe('V32 entity revision ledger migration', () => {
  it('creates the append-only revision table and lookup index', async () => {
    const { applyMigrations, CURRENT_SCHEMA_VERSION } = await import('../../dist/domains/memory/schema.js');
    const db = new Database(':memory:');

    applyMigrations(db);

    assert.ok(CURRENT_SCHEMA_VERSION >= 32);
    const columns = db.prepare('PRAGMA table_info(entity_revision_events)').all();
    assert.deepEqual(
      columns.map((column) => column.name),
      [
        'revision_id',
        'entity_id',
        'operation',
        'before_json',
        'after_json',
        'source',
        'actor_id',
        'proposal_id',
        'reason',
        'created_at',
      ],
    );
    const indexes = db.prepare("PRAGMA index_list('entity_revision_events')").all();
    assert.ok(indexes.some((index) => index.name === 'idx_entity_revision_events_entity_time'));
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'entity_revision_events'")
      .all();
    assert.deepEqual(triggers.map((trigger) => trigger.name).sort(), [
      'entity_revision_events_no_delete',
      'entity_revision_events_no_update',
    ]);
  });

  it('upgrades a V31 database idempotently', async () => {
    const { applyMigrations, CURRENT_SCHEMA_VERSION } = await import('../../dist/domains/memory/schema.js');
    const db = new Database(':memory:');
    applyMigrations(db);
    db.exec('DROP TABLE entity_revision_events');
    db.prepare('DELETE FROM schema_version WHERE version >= 32').run();

    assert.doesNotThrow(() => applyMigrations(db));
    assert.doesNotThrow(() => applyMigrations(db));
    const version = db.prepare('SELECT MAX(version) AS version FROM schema_version').get();
    assert.equal(version.version, CURRENT_SCHEMA_VERSION);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'entity_revision_events'").get());
  });

  it('rejects update and delete attempts against revision history', async () => {
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const db = new Database(':memory:');
    applyMigrations(db);
    db.prepare(`
      INSERT INTO entity_revision_events
      (entity_id, operation, before_json, after_json, source, created_at)
      VALUES (?, 'create', NULL, '{}', 'system', ?)
    `).run('concept:test', '2026-07-18T00:00:00.000Z');

    assert.throws(() => db.prepare("UPDATE entity_revision_events SET reason = 'rewrite'").run(), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM entity_revision_events').run(), /append-only/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM entity_revision_events').get().count, 1);
  });
});
