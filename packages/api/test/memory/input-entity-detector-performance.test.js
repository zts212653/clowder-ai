import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { InputEntityDetector } from '../../dist/domains/memory/InputEntityDetector.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

test('a short human input stays within 500ms against 10,000 unrelated document aliases', () => {
  const db = new Database(':memory:');
  try {
    applyMigrations(db);
    const insert =
      db.prepare(`INSERT INTO doc_aliases (alias_norm, alias, doc_anchor, source, authority_tier, created_at)
      VALUES (?, ?, ?, 'doc-title', 'standard', '2026-10-16')`);
    db.transaction(() => {
      for (let i = 0; i < 10_000; i++) {
        const alias = `unrelated-archive-entry-${i}`;
        insert.run(alias, alias, `unrelated:${i}`);
      }
      insert.run('memory surface', 'Memory Surface', 'docs/memory-surface.md');
    })();
    const detector = new InputEntityDetector(db);
    const started = performance.now();
    const matches = detector.detect('查看 Memory Surface 的延迟。');
    const elapsed = performance.now() - started;
    assert.deepEqual(
      matches.map((match) => match.docAnchor),
      ['docs/memory-surface.md'],
    );
    assert.ok(elapsed < 500, `unrelated aliases consumed ${elapsed.toFixed(1)}ms of a human send`);
  } finally {
    db.close();
  }
});
