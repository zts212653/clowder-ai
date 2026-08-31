import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('V27 migration — dynamic_task_defs retry_attempts', () => {
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
      assert.equal(schema.CURRENT_SCHEMA_VERSION, 40);
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
      assert.equal(schema.CURRENT_SCHEMA_VERSION, 40);
    } finally {
      db.close();
    }
  });

  it('upgrades an existing upstream V39 database with the scheduler retry column', async () => {
    const Database = (await import('better-sqlite3')).default;
    const schema = await import('../../dist/domains/memory/schema.js');

    const db = new Database(':memory:');
    try {
      schema.applyMigrations(db);
      db.exec('ALTER TABLE dynamic_task_defs DROP COLUMN retry_attempts');
      db.prepare('DELETE FROM schema_version WHERE version = 40').run();

      schema.applyMigrations(db);

      const cols = db.prepare("PRAGMA table_info('dynamic_task_defs')").all();
      assert.ok(cols.some((col) => col.name === 'retry_attempts'));
      assert.equal(db.prepare('SELECT MAX(version) as v FROM schema_version').get().v, 40);
    } finally {
      db.close();
    }
  });
});
