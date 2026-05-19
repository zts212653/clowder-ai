import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('F200 consumption rerank integration', () => {
  let Database, applyMigrations, SCHEMA_V1, applyConsumptionRerank, lookupShadowRanking;
  let db;
  const savedEnv = {};

  beforeEach(async () => {
    Database = (await import('better-sqlite3')).default;
    const schema = await import('../../dist/domains/memory/schema.js');
    applyMigrations = schema.applyMigrations;
    SCHEMA_V1 = schema.SCHEMA_V1;
    const storeMod = await import(`../../dist/domains/memory/SqliteEvidenceStore.js?v=${Date.now()}`);
    applyConsumptionRerank = storeMod.applyConsumptionRerank;
    lookupShadowRanking = storeMod.lookupShadowRanking;

    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    applyMigrations(db);

    savedEnv.F200 = process.env.F200_CONSUMPTION_RERANK;
  });

  afterEach(() => {
    if (savedEnv.F200 === undefined) delete process.env.F200_CONSUMPTION_RERANK;
    else process.env.F200_CONSUMPTION_RERANK = savedEnv.F200;
  });

  function insertDoc(anchor, kind, authority = 'observed') {
    db.prepare(
      `INSERT OR IGNORE INTO evidence_docs (anchor, kind, status, title, summary, updated_at, authority)
       VALUES (?, ?, 'active', ?, '', datetime('now'), ?)`,
    ).run(anchor, kind, anchor, authority);
  }

  function insertMetric(anchor, consumed30d, exposure30d, dormancyDays) {
    db.prepare(
      `INSERT OR REPLACE INTO anchor_recall_metrics
       (anchor, consumed_count_30d, exposure_count_30d, dormancy_days, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    ).run(anchor, consumed30d, exposure30d, dormancyDays);
  }

  function insertBaseline(docKind, meanCtr) {
    db.prepare(
      'INSERT OR REPLACE INTO global_ctr_baseline (doc_kind, mean_ctr, sample_count, updated_at) VALUES (?, ?, 100, ?)',
    ).run(docKind, meanCtr, Date.now());
  }

  function getDoc(anchor) {
    const row = db.prepare('SELECT * FROM evidence_docs WHERE anchor = ?').get(anchor);
    return {
      anchor: row.anchor,
      kind: row.kind,
      status: row.status,
      title: row.title,
      summary: row.summary || '',
      updatedAt: row.updated_at,
      authority: row.authority,
      firstIndexedAt: row.first_indexed_at ?? 0,
    };
  }

  it('off mode: no reranking', () => {
    process.env.F200_CONSUMPTION_RERANK = 'off';
    insertDoc('A', 'feature');
    insertDoc('B', 'feature');
    insertMetric('A', 0, 50, 60);
    insertMetric('B', 20, 30, 1);
    const results = [getDoc('A'), getDoc('B')];
    applyConsumptionRerank(results, db);
    assert.equal(results[0].anchor, 'A', 'off mode should not reorder');
  });

  it('on mode: reranks by consumption_prior + recency_decay', () => {
    process.env.F200_CONSUMPTION_RERANK = 'on';
    insertDoc('low-ctr', 'feature');
    insertDoc('high-ctr', 'feature');
    insertMetric('low-ctr', 0, 50, 90);
    insertMetric('high-ctr', 20, 30, 1);
    insertBaseline('feature', 0.2);
    const results = [getDoc('low-ctr'), getDoc('high-ctr')];
    applyConsumptionRerank(results, db);
    assert.equal(results[0].anchor, 'high-ctr', 'high-CTR anchor should be promoted');
  });

  it('shadow mode: computes but preserves original order', () => {
    process.env.F200_CONSUMPTION_RERANK = 'shadow';
    insertDoc('A', 'feature');
    insertDoc('B', 'feature');
    insertMetric('A', 0, 50, 90);
    insertMetric('B', 20, 30, 1);
    insertBaseline('feature', 0.2);
    const results = [getDoc('A'), getDoc('B')];
    applyConsumptionRerank(results, db);
    assert.equal(results[0].anchor, 'A', 'shadow mode should preserve original order');
  });

  it('constitutional anchor immune to demotion (AC-C5)', () => {
    process.env.F200_CONSUMPTION_RERANK = 'on';
    insertDoc('adr-important', 'adr', 'constitutional');
    insertDoc('popular-feature', 'feature');
    insertMetric('adr-important', 0, 50, 180);
    insertMetric('popular-feature', 30, 40, 1);
    insertBaseline('adr', 0.1);
    insertBaseline('feature', 0.2);
    const results = [getDoc('adr-important'), getDoc('popular-feature')];
    applyConsumptionRerank(results, db);
    assert.equal(results[0].anchor, 'adr-important', 'constitutional should not be demoted');
  });

  it('no metrics: cold-start treatment preserves order', () => {
    process.env.F200_CONSUMPTION_RERANK = 'on';
    insertDoc('A', 'feature');
    insertDoc('B', 'feature');
    const results = [getDoc('A'), getDoc('B')];
    applyConsumptionRerank(results, db);
    assert.equal(results[0].anchor, 'A', 'no metrics → cold-start → order preserved');
  });

  it('single result: no-op', () => {
    process.env.F200_CONSUMPTION_RERANK = 'on';
    insertDoc('A', 'feature');
    const results = [getDoc('A')];
    applyConsumptionRerank(results, db);
    assert.equal(results.length, 1);
  });

  it('MMR trim does not crash with OOB (R2-P1)', () => {
    process.env.F200_CONSUMPTION_RERANK = 'on';
    for (let i = 0; i < 30; i++) {
      insertDoc(`doc-${i}`, 'feature');
      insertMetric(`doc-${i}`, i, 30, i + 1);
    }
    insertBaseline('feature', 0.2);
    const results = [];
    for (let i = 0; i < 30; i++) results.push(getDoc(`doc-${i}`));
    assert.doesNotThrow(() => applyConsumptionRerank(results, db, 5));
  });

  it('shadow ranking key uses truncated output, not full pool (R3-P1)', () => {
    process.env.F200_CONSUMPTION_RERANK = 'shadow';
    for (let i = 0; i < 15; i++) {
      insertDoc(`doc-${i}`, 'feature');
      insertMetric(`doc-${i}`, i, 30, i + 1);
    }
    insertBaseline('feature', 0.2);
    const results = [];
    for (let i = 0; i < 15; i++) results.push(getDoc(`doc-${i}`));
    applyConsumptionRerank(results, db, 5);
    // After rerank, caller will truncate to targetLimit=5. Lookup must use those 5 anchors.
    const returnedAnchors = results.slice(0, 5).map((r) => r.anchor);
    const ranking = lookupShadowRanking(returnedAnchors);
    assert.ok(ranking, 'shadow ranking must be retrievable using truncated top-5 anchors, not full pool');
    assert.ok(ranking.length > 0);
  });

  it('keyed shadow ranking: lookupShadowRanking returns matching entry (R2-P4)', () => {
    process.env.F200_CONSUMPTION_RERANK = 'shadow';
    insertDoc('X', 'feature');
    insertDoc('Y', 'feature');
    insertMetric('X', 5, 20, 3);
    insertMetric('Y', 1, 20, 10);
    insertBaseline('feature', 0.2);
    const results = [getDoc('X'), getDoc('Y')];
    applyConsumptionRerank(results, db);
    const ranking = lookupShadowRanking(results.map((r) => r.anchor));
    assert.ok(ranking, 'shadow ranking should be retrievable by result anchors');
    assert.equal(ranking.length, 2);
    assert.ok(ranking.every((r) => typeof r.shadowRank === 'number'));
  });
});
