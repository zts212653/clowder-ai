import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('SqliteEvidenceStore lexical backfill', () => {
  let store;
  const savedEnv = {};

  beforeEach(async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    savedEnv.F163 = process.env.F163_AUTHORITY_BOOST;
    savedEnv.F200 = process.env.F200_CONSUMPTION_RERANK;
  });

  afterEach(() => {
    if (savedEnv.F163 === undefined) delete process.env.F163_AUTHORITY_BOOST;
    else process.env.F163_AUTHORITY_BOOST = savedEnv.F163;
    if (savedEnv.F200 === undefined) delete process.env.F200_CONSUMPTION_RERANK;
    else process.env.F200_CONSUMPTION_RERANK = savedEnv.F200;
  });

  it('boosts section-keyword hits ahead of incidental FTS matches', async () => {
    await store.upsert([
      {
        anchor: 'doc:stories/cat-names',
        kind: 'note',
        status: 'active',
        title: 'Clowder AI 花名册 — 名字的由来',
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
        title: 'Clowder AI 花名册 — 名字的由来',
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

  it('keeps exact CJK title hits ahead of authority and consumption reranks', async () => {
    process.env.F163_AUTHORITY_BOOST = 'on';
    process.env.F200_CONSUMPTION_RERANK = 'on';

    await store.upsert([
      {
        anchor: 'doc:cucu-story',
        kind: 'lesson',
        status: 'active',
        title: '醋醋喵诞生记：大缅因猫醋意 max 与一张头像的标准 PR 流程',
        summary: '给 Fable 5 换头像引发的故事。',
        keywords: ['醋醋喵', '大缅因猫醋意 max'],
        updatedAt: '2026-06-11T00:00:00Z',
      },
      {
        anchor: 'F092',
        kind: 'feature',
        status: 'active',
        title: 'F092 — Cats & U 语音陪伴体验',
        summary: 'M4 Max 语音陪伴资料。',
        authority: 'constitutional',
        updatedAt: '2026-06-10T00:00:00Z',
      },
    ]);

    const db = store.getDb();
    db.prepare(
      `INSERT OR REPLACE INTO anchor_recall_metrics
       (anchor, consumed_count_30d, exposure_count_30d, dormancy_days, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    ).run('F092', 30, 30, 1);
    db.prepare(
      'INSERT OR REPLACE INTO global_ctr_baseline (doc_kind, mean_ctr, sample_count, updated_at) VALUES (?, ?, 100, ?)',
    ).run('feature', 0.2, Date.now());

    const results = await store.search('大缅因猫醋意 max', {
      mode: 'lexical',
      scope: 'docs',
      limit: 5,
    });

    assert.equal(results[0]?.anchor, 'doc:cucu-story');
  });
});
