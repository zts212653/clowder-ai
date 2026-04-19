import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('SqliteEvidenceStore lexical backfill', () => {
  let store;

  beforeEach(async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
  });

  it('boosts section-keyword hits ahead of incidental FTS matches', async () => {
    await store.upsert([
      {
        anchor: 'doc:stories/cat-names',
        kind: 'note',
        status: 'active',
        title: 'Cat Cafe 花名册 — 名字的由来',
        summary: '这里记录每只猫名字背后的来历。',
        keywords: ['宪宪', '砚砚', '烁烁'],
        updatedAt: '2026-04-15T00:00:00Z',
      },
      {
        anchor: 'doc:f102-review-thread',
        kind: 'note',
        status: 'active',
        title: 'F102 review notes',
        summary: '宪宪',
        updatedAt: '2026-04-14T00:00:00Z',
      },
    ]);

    const results = await store.search('宪宪', {
      mode: 'lexical',
      scope: 'docs',
      limit: 1,
    });

    assert.equal(results.length, 1);
    assert.equal(
      results[0].anchor,
      'doc:stories/cat-names',
      'section-heading keyword hit should outrank incidental summary mentions',
    );
  });

  it('backfills docs from title or summary substrings when FTS tokenization misses', async () => {
    await store.upsert([
      {
        anchor: 'doc:stories/cat-names',
        kind: 'note',
        status: 'active',
        title: 'Cat Cafe 花名册 — 名字的由来',
        summary: '这里记录每只猫名字背后的来历。',
        keywords: ['宪宪', '砚砚', '烁烁'],
        updatedAt: '2026-04-15T00:00:00Z',
      },
      {
        anchor: 'doc:naming-rules',
        kind: 'note',
        status: 'active',
        title: '命名规则设计',
        summary: '讨论系统里怎么给对象命名。',
        updatedAt: '2026-04-14T00:00:00Z',
      },
    ]);

    const results = await store.search('花名册 命名', {
      mode: 'lexical',
      scope: 'docs',
      limit: 5,
    });

    assert.ok(
      results.some((result) => result.anchor === 'doc:stories/cat-names'),
      'title substring matches should be able to backfill the cat naming doc',
    );
  });
});
