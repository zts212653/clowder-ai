import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

describe('V28 migration — evidence_fts keywords', () => {
  it('rebuilds existing evidence_fts with keyword tokens', async () => {
    const Database = (await import('better-sqlite3')).default;
    const schema = await import('../../dist/domains/memory/schema.js');

    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE evidence_docs (
          anchor TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT,
          keywords TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE evidence_fts USING fts5(
          title, summary,
          content=evidence_docs, content_rowid=rowid
        );
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        -- Minimal recall_events stub: later migrations (V31 ALTER, V33 INDEX)
        -- reference this table. Production databases have it from V19; partial
        -- test fixtures that start at V27+ must include the stub.
        CREATE TABLE IF NOT EXISTS recall_events (
          recall_id TEXT PRIMARY KEY,
          invocation_id TEXT,
          cat_id TEXT,
          timestamp TEXT,
          query_text TEXT,
          result_count INTEGER,
          consumed_json TEXT NOT NULL DEFAULT '[]'
        );
      `);
      db.prepare(
        `INSERT INTO evidence_docs(anchor, kind, status, title, summary, keywords, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'doc:legacy-keyword',
        'architecture',
        'active',
        'Legacy Keyword Doc',
        'The rare token is not in title or summary',
        JSON.stringify(['rarekeywordxyz']),
        '2026-07-05T00:00:00Z',
      );
      db.exec(`
        INSERT INTO evidence_fts(rowid, title, summary)
        SELECT rowid, title, summary FROM evidence_docs
      `);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(27, new Date().toISOString());

      schema.applyMigrations(db);

      const rows = db.prepare('SELECT rowid FROM evidence_fts WHERE evidence_fts MATCH ?').all('rarekeywordxyz');
      assert.equal(rows.length, 1, 'V28 should rebuild FTS with existing keywords');
      const version = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
      assert.equal(version.v, schema.CURRENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('wraps the destructive FTS rebuild in one transaction', () => {
    const schemaSource = readFileSync(resolve('src/domains/memory/schema.ts'), 'utf-8');
    const v28Block = schemaSource.match(/if \(currentVersion < 28\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
    assert.match(v28Block, /db\.transaction\(\(\) => \{/, 'V28 migration should use one explicit transaction');
    assert.match(v28Block, /DROP TABLE IF EXISTS evidence_fts/);
    assert.match(v28Block, /INSERT INTO evidence_fts/);
  });
});
