import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('V26 migration — recall_events result_count', () => {
  it('adds nullable result_count for reported search hit count', async () => {
    const Database = (await import('better-sqlite3')).default;
    const schema = await import('../../dist/domains/memory/schema.js');

    const db = new Database(':memory:');
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec(schema.SCHEMA_V1);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
      schema.applyMigrations(db);

      const cols = db.prepare("PRAGMA table_info('recall_events')").all();
      const resultCount = cols.find((col) => col.name === 'result_count');
      assert.ok(resultCount, 'result_count column exists');
      assert.equal(resultCount.notnull, 0, 'result_count is nullable so old rows can stay unknown');
      assert.equal(schema.CURRENT_SCHEMA_VERSION, 26);
    } finally {
      db.close();
    }
  });
});
