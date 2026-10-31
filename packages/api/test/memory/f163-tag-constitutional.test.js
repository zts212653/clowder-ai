/**
 * F163: Tag constitutional knowledge — shared-rules + P0 LL items
 * Tests the tagging logic (anchor matching + authority/activation update)
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { CONSTITUTIONAL_PATTERNS, tagConstitutional } from '../../dist/domains/memory/f163-tag-constitutional.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

describe('F163 Tag Constitutional', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMigrations(db);
  });

  it('CONSTITUTIONAL_PATTERNS contains shared-rules and P0 LL entries', () => {
    assert.ok(CONSTITUTIONAL_PATTERNS.length > 0);
    assert.ok(CONSTITUTIONAL_PATTERNS.some((p) => p.includes('shared-rules') || p.includes('SOP')));
    assert.ok(CONSTITUTIONAL_PATTERNS.some((p) => p.includes('lessons-learned') || p.includes('LL-')));
  });

  it('tags matching docs as constitutional + always_on', () => {
    // Insert a doc matching a constitutional pattern
    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, summary, source_path, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('docs/SOP.md', 'plan', 'active', 'SOP', 'Standard operating procedures', 'SOP.md', '2026-01-01');

    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, summary, source_path, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'docs/lessons-learned.md',
      'lesson',
      'active',
      'Lessons Learned',
      'All lessons',
      'lessons-learned.md',
      '2026-01-01',
    );

    // Insert a non-constitutional doc
    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, summary, source_path, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'docs/features/F042.md',
      'feature',
      'active',
      'F042',
      'Prompt optimization',
      'features/F042.md',
      '2026-01-01',
    );

    const result = tagConstitutional(db);

    assert.ok(result.tagged > 0, 'should tag at least one doc');
    assert.ok(result.tagged <= 2, 'should only tag matching docs');

    // Verify the tagged doc
    const sop = db.prepare('SELECT authority, activation FROM evidence_docs WHERE anchor = ?').get('docs/SOP.md');
    assert.equal(sop.authority, 'constitutional');
    assert.equal(sop.activation, 'always_on');

    // Verify the non-constitutional doc is untouched
    const f042 = db
      .prepare('SELECT authority, activation FROM evidence_docs WHERE anchor = ?')
      .get('docs/features/F042.md');
    assert.equal(f042.authority, 'observed');
    assert.equal(f042.activation, 'query');
  });

  it('sets verified_at timestamp on tagged docs', () => {
    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, summary, source_path, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('docs/SOP.md', 'plan', 'active', 'SOP', 'Standard operating procedures', 'SOP.md', '2026-01-01');

    tagConstitutional(db);

    const row = db.prepare('SELECT verified_at FROM evidence_docs WHERE anchor = ?').get('docs/SOP.md');
    assert.ok(row.verified_at, 'verified_at should be set');
    assert.match(row.verified_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('is idempotent — second run does not double-tag', () => {
    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, summary, source_path, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('docs/SOP.md', 'plan', 'active', 'SOP', 'Standard operating procedures', 'SOP.md', '2026-01-01');

    const first = tagConstitutional(db);
    const second = tagConstitutional(db);

    // Second run should not error and should still report tagged count
    assert.ok(first.tagged > 0);
    assert.ok(second.tagged >= 0);

    // Verify still only one row
    const rows = db.prepare("SELECT * FROM evidence_docs WHERE authority = 'constitutional'").all();
    assert.equal(rows.length, 1);
  });
});
