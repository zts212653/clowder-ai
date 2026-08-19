import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('V27 migration — recall_events result_status', () => {
  it('adds nullable result_status for structured recall outcome state', async () => {
    const Database = (await import('better-sqlite3')).default;
    const schema = await import('../../dist/domains/memory/schema.js');

    const db = new Database(':memory:');
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec(schema.SCHEMA_V1);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
      schema.applyMigrations(db);

      const cols = db.prepare("PRAGMA table_info('recall_events')").all();
      const resultStatus = cols.find((col) => col.name === 'result_status');
      assert.ok(resultStatus, 'result_status column exists');
      assert.equal(resultStatus.notnull, 0, 'result_status is nullable so old rows can stay legacy_unknown');
      assert.ok(schema.CURRENT_SCHEMA_VERSION >= 27);
    } finally {
      db.close();
    }
  });
});
