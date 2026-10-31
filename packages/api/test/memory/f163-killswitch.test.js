/**
 * F163: Kill-switch / fail-open for read path.
 * Boost errors degrade gracefully to legacy results.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

describe('F163 Kill-switch / Fail-open', () => {
  let store;

  beforeEach(async () => {
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    // Insert test docs
    await store.upsert([
      {
        anchor: 'doc-1',
        kind: 'decision',
        status: 'active',
        title: 'Decision One about Redis',
        summary: 'Redis integration decision',
        sourcePath: 'decisions/001.md',
        updatedAt: '2026-01-01',
      },
      {
        anchor: 'doc-2',
        kind: 'lesson',
        status: 'active',
        title: 'Lesson about Redis pitfall',
        summary: 'Redis port conflict lesson',
        sourcePath: 'lessons/002.md',
        updatedAt: '2026-01-01',
      },
    ]);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }
  });

  it('returns results normally when boost succeeds', async () => {
    process.env.F163_AUTHORITY_BOOST = 'on';

    const results = await store.search('Redis');
    assert.ok(results.length > 0, 'should return results');
  });

  it('returns results even when authority column has unexpected values', async () => {
    // Set an unexpected authority value to simulate corruption
    const db = store.getDb();
    db.prepare("UPDATE evidence_docs SET authority = 'INVALID_VALUE' WHERE anchor = 'doc-1'").run();
    process.env.F163_AUTHORITY_BOOST = 'on';

    // Should not throw — falls back gracefully
    const results = await store.search('Redis');
    assert.ok(results.length > 0, 'should still return results despite invalid authority');
  });

  it('search works with all flags off (legacy path)', async () => {
    const results = await store.search('Redis');
    assert.ok(results.length > 0, 'legacy path should return results');
  });
});
