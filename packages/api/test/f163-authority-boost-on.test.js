/**
 * F163 Phase D (AC-D4): With authority_boost=on, constitutional docs
 * rank above observed docs for the same query.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { SqliteEvidenceStore } from '../dist/domains/memory/SqliteEvidenceStore.js';

describe('F163 authority_boost=on reranking', () => {
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }
  });

  it('constitutional doc ranks above observed doc with boost=on', async () => {
    process.env.F163_AUTHORITY_BOOST = 'on';

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    await store.upsert([
      {
        anchor: 'doc:discussions/2026-01-01-redis-chat',
        kind: 'discussion',
        status: 'active',
        title: 'Redis cache discussion chat log',
        summary:
          'Redis cache eviction policy discussion with multiple references to Redis configuration and Redis tuning Redis Redis Redis',
        sourcePath: 'discussions/2026-01-01-redis-chat.md',
        updatedAt: '2026-01-01',
      },
      {
        anchor: 'doc:lessons-learned',
        kind: 'lesson',
        status: 'active',
        title: 'Redis 6399 iron rule',
        summary: 'Redis 6399 is sacred — never connect dev to production Redis',
        sourcePath: 'lessons-learned.md',
        updatedAt: '2026-01-01',
      },
    ]);

    const results = await store.search('Redis');
    assert.ok(results.length >= 2, `expected >=2 results, got ${results.length}`);

    const lessonIdx = results.findIndex((r) => r.anchor === 'doc:lessons-learned');
    const chatIdx = results.findIndex((r) => r.anchor === 'doc:discussions/2026-01-01-redis-chat');

    assert.ok(lessonIdx >= 0, 'lesson should be in results');
    assert.ok(chatIdx >= 0, 'discussion should be in results');
    assert.ok(
      lessonIdx < chatIdx,
      `constitutional lesson (idx=${lessonIdx}) should rank above observed discussion (idx=${chatIdx})`,
    );
  });

  it('authority backfill assigns correct levels via pathToAuthority', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    await store.upsert([
      {
        anchor: 'doc:ll',
        kind: 'lesson',
        status: 'active',
        title: 'Lessons',
        sourcePath: 'lessons-learned.md',
        updatedAt: '2026-01-01',
      },
      {
        anchor: 'doc:adr',
        kind: 'decision',
        status: 'active',
        title: 'ADR',
        sourcePath: 'decisions/001-foo.md',
        updatedAt: '2026-01-01',
      },
      {
        anchor: 'doc:disc',
        kind: 'discussion',
        status: 'active',
        title: 'Discussion',
        sourcePath: 'discussions/2026-01-01-foo.md',
        updatedAt: '2026-01-01',
      },
      {
        anchor: 'doc:misc',
        kind: 'lesson',
        status: 'active',
        title: 'Misc',
        sourcePath: 'random/file.md',
        updatedAt: '2026-01-01',
      },
    ]);

    const db = store.getDb();
    const rows = db.prepare('SELECT anchor, authority FROM evidence_docs ORDER BY anchor').all();

    const byAnchor = Object.fromEntries(rows.map((r) => [r.anchor, r.authority]));
    assert.equal(byAnchor['doc:adr'], 'validated');
    assert.equal(byAnchor['doc:disc'], 'candidate');
    assert.equal(byAnchor['doc:ll'], 'constitutional');
    assert.equal(byAnchor['doc:misc'], 'observed');
  });
});
