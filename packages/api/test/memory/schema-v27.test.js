import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('dynamic_task_defs retry_attempts — stamp-neutral column reconciliation', () => {
  // Not a numbered migration: one schema_version counter is shared by the upstream
  // and fork lineages, so a block number is not a reliable carrier for this column.
  // applyMigrations reconciles it by column presence on every pass instead.
  it('adds retry_attempts with default 0 for durable once-task retry progress', async () => {
    const Database = (await import('better-sqlite3')).default;
    const schema = await import('../../dist/domains/memory/schema.js');

    const db = new Database(':memory:');
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec(schema.SCHEMA_V1);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
      schema.applyMigrations(db);

      const cols = db.prepare("PRAGMA table_info('dynamic_task_defs')").all();
      const retryAttempts = cols.find((col) => col.name === 'retry_attempts');
      assert.ok(retryAttempts, 'retry_attempts column exists');
      assert.equal(retryAttempts.dflt_value, '0', 'retry_attempts defaults to 0');
      assert.equal(retryAttempts.notnull, 0, 'retry_attempts is nullable for backwards compat');

      const version = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
      assert.equal(version.v, schema.CURRENT_SCHEMA_VERSION);
      assert.ok(Number.isInteger(schema.CURRENT_SCHEMA_VERSION), 'the ladder exposes a version stamp');
    } finally {
      db.close();
    }
  });

  it('idempotent: applying migrations twice leaves schema_version at the current version', async () => {
    const Database = (await import('better-sqlite3')).default;
    const schema = await import('../../dist/domains/memory/schema.js');

    const db = new Database(':memory:');
    try {
      db.exec('PRAGMA journal_mode = WAL');
      schema.applyMigrations(db);
      schema.applyMigrations(db);

      const version = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
      assert.equal(version.v, schema.CURRENT_SCHEMA_VERSION);
      assert.ok(Number.isInteger(schema.CURRENT_SCHEMA_VERSION), 'the ladder exposes a version stamp');
    } finally {
      db.close();
    }
  });

  it('repairs a database stamped as migrated but missing the column', async () => {
    const Database = (await import('better-sqlite3')).default;
    const schema = await import('../../dist/domains/memory/schema.js');

    const db = new Database(':memory:');
    try {
      schema.applyMigrations(db);
      // Drop the column WITHOUT touching the stamp: this is exactly the state a
      // lineage collision produces — stamped as done, column absent.
      db.exec('ALTER TABLE dynamic_task_defs DROP COLUMN retry_attempts');
      const stampBefore = db.prepare('SELECT MAX(version) as v FROM schema_version').get().v;

      schema.applyMigrations(db);

      const cols = db.prepare("PRAGMA table_info('dynamic_task_defs')").all();
      assert.ok(cols.some((col) => col.name === 'retry_attempts'));
      assert.equal(
        db.prepare('SELECT MAX(version) as v FROM schema_version').get().v,
        stampBefore,
        'reconciliation restores the column without moving the stamp in either direction',
      );
    } finally {
      db.close();
    }
  });
});
