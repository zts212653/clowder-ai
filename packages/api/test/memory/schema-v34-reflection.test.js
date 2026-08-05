import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';

describe('V34 reflection supply ledger migration', () => {
  it('adds persisted drill-down metadata and the reflection output ledger', async () => {
    const { applyMigrations, CURRENT_SCHEMA_VERSION } = await import('../../dist/domains/memory/schema.js');
    const db = new Database(':memory:');

    applyMigrations(db);

    assert.equal(CURRENT_SCHEMA_VERSION, 38);
    const evidenceColumns = db.prepare('PRAGMA table_info(evidence_docs)').all();
    assert.ok(evidenceColumns.some((column) => column.name === 'drill_down_json'));
    const reflectionColumns = db.prepare('PRAGMA table_info(reflection_outputs)').all();
    assert.deepEqual(
      reflectionColumns.map((column) => column.name),
      [
        'output_id',
        'owner_user_id',
        'household_local_date',
        'cat_id',
        'source_ref_json',
        'output_kind',
        'normalized_claim',
        'reason',
        'claim_fingerprint',
        'destination',
        'projection_state',
        'projection_ref',
        'producer',
        'created_at',
        'delivered_at',
      ],
    );
    const byName = new Map(reflectionColumns.map((column) => [column.name, column]));
    assert.equal(byName.get('normalized_claim').notnull, 0);
    assert.equal(byName.get('reason').notnull, 0);
    assert.equal(byName.get('claim_fingerprint').notnull, 1);
  });

  it('repairs an interrupted V34 migration without swallowing schema errors', async () => {
    const { applyMigrations, CURRENT_SCHEMA_VERSION } = await import('../../dist/domains/memory/schema.js');
    const db = new Database(':memory:');
    applyMigrations(db);
    db.exec('DROP TABLE reflection_outputs');
    // Simulate a crash before V34 committed. A later migration cannot have
    // committed in that state, so remove V34 and every dependent version.
    db.prepare('DELETE FROM schema_version WHERE version >= 34').run();

    assert.doesNotThrow(() => applyMigrations(db));
    assert.doesNotThrow(() => applyMigrations(db));
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'reflection_outputs'").get());
    assert.equal(
      db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version,
      CURRENT_SCHEMA_VERSION,
    );
  });
});
