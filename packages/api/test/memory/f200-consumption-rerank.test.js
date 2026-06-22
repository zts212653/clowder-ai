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

  function insertDoc(anchor, kind, authority = 'observed', title = anchor, summary = '') {
    db.prepare(
      `INSERT OR IGNORE INTO evidence_docs (anchor, kind, status, title, summary, updated_at, authority)
       VALUES (?, ?, 'active', ?, ?, datetime('now'), ?)`,
    ).run(anchor, kind, title, summary, authority);
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

  it('on mode: preserves exact lexical hits for named CJK queries', () => {
    process.env.F200_CONSUMPTION_RERANK = 'on';
    insertDoc(
      'exact-story',
      'lesson',
      'observed',
      '醋醋喵诞生记：大缅因猫醋意 max 与一张头像的标准 PR 流程',
      '这就是醋醋喵 story 的原案。',
    );
    insertDoc('popular-max', 'feature', 'observed', 'M4 Max TTS 调研', '常被读取的泛化资料');
    insertMetric('exact-story', 0, 30, 90);
    insertMetric('popular-max', 30, 30, 1);
    insertBaseline('feature', 0.2);
    insertBaseline('lesson', 0.1);

    const results = [getDoc('exact-story'), getDoc('popular-max')];
    applyConsumptionRerank(results, db, undefined, '大缅因猫醋意 max');

    assert.equal(results[0].anchor, 'exact-story', 'exact named-story match must not be demoted by consumption prior');
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

  it('HW-7: on mode shadow stores pre-rerank BM25 order, not post-rerank (shadow≡live bug)', () => {
    // HW-7 Part 2: In 'on' mode, shadow was stored from `final` (reranked order),
    // making shadow ≡ live by construction. shadowConsumedMRR / liveOnShadowSubsetMRR ≈ 1 always.
    // Fix: shadow must store original BM25 order (pre-rerank positions).
    process.env.F200_CONSUMPTION_RERANK = 'on';

    // BM25 order: low-ctr at position 0, high-ctr at position 1
    insertDoc('low-ctr', 'feature');
    insertDoc('high-ctr', 'feature');
    insertMetric('low-ctr', 0, 50, 90); // zero consumption, old, should rank lower
    insertMetric('high-ctr', 20, 30, 1); // high consumption, recent, should be promoted
    insertBaseline('feature', 0.2);

    const results = [getDoc('low-ctr'), getDoc('high-ctr')];
    applyConsumptionRerank(results, db);

    // After reranking in 'on' mode: high-ctr promoted to position 0
    assert.equal(results[0].anchor, 'high-ctr', 'precondition: on mode reranks');

    // Shadow should reflect ORIGINAL BM25 order (low-ctr=0, high-ctr=1),
    // not the reranked order (high-ctr=0, low-ctr=1)
    const ranking = lookupShadowRanking(results.map((r) => r.anchor));
    assert.ok(ranking, 'shadow ranking should exist');
    const shadowMap = Object.fromEntries(ranking.map((r) => [r.anchor, r.shadowRank]));
    assert.equal(shadowMap['low-ctr'], 0, 'shadow: low-ctr was at BM25 position 0');
    assert.equal(shadowMap['high-ctr'], 1, 'shadow: high-ctr was at BM25 position 1');
  });

  it('Cloud-P2: shadow stores original BM25 order, not post-partition order (lexical protection bias)', () => {
    // Cloud review P2: when lexical protection partitions results, shadow was built from
    // [protectedResults, rerankPool] instead of original results array.
    // BM25 order: popular(0) → exact-story(1) → other(2)
    // After partition: protectedResults=[exact-story], rerankPool=[popular, other]
    // Bug: shadow=[exact-story=0, popular=1, other=2] (partition order, not BM25)
    // Fix: shadow=[popular=0, exact-story=1, other=2] (original BM25 order)
    process.env.F200_CONSUMPTION_RERANK = 'on';
    insertDoc('exact-story', 'lesson', 'observed', '醋醋喵诞生记：大缅因猫醋意 max', '这就是醋醋喵 story 的原案。');
    insertDoc('popular-max', 'feature', 'observed', 'M4 Max TTS 调研', '常被读取的泛化资料');
    insertDoc('other-doc', 'feature', 'observed', '其他 max 相关', '其他文档');
    insertMetric('exact-story', 0, 30, 90);
    insertMetric('popular-max', 30, 30, 1);
    insertMetric('other-doc', 5, 30, 10);
    insertBaseline('feature', 0.2);
    insertBaseline('lesson', 0.1);

    // BM25 order: popular-max(0), exact-story(1), other-doc(2)
    const results = [getDoc('popular-max'), getDoc('exact-story'), getDoc('other-doc')];
    applyConsumptionRerank(results, db, undefined, '大缅因猫醋意 max');

    // exact-story should be protected (lexical hit), but shadow should reflect ORIGINAL BM25 positions
    const ranking = lookupShadowRanking(results.map((r) => r.anchor));
    assert.ok(ranking, 'shadow ranking should exist');
    const shadowMap = Object.fromEntries(ranking.map((r) => [r.anchor, r.shadowRank]));
    // Original BM25: popular-max=0, exact-story=1, other-doc=2
    assert.equal(shadowMap['popular-max'], 0, 'shadow: popular-max was at BM25 position 0');
    assert.equal(shadowMap['exact-story'], 1, 'shadow: exact-story was at BM25 position 1');
    assert.equal(shadowMap['other-doc'], 2, 'shadow: other-doc was at BM25 position 2');
  });

  it('Cloud-P1-3: shadow mode stores would-be reranked order, not BM25 order (shadow experiment semantics)', () => {
    // Cloud review P1: In shadow mode, live = BM25 (unchanged), so shadow must store
    // the hypothetical reranked order. If shadow also stores BM25, shadow ≡ live
    // and the A/B experiment yields zero signal.
    process.env.F200_CONSUMPTION_RERANK = 'shadow';

    // BM25 order: low-ctr(0), high-ctr(1)
    // Consumption reranking would promote high-ctr to position 0
    insertDoc('low-ctr', 'feature');
    insertDoc('high-ctr', 'feature');
    insertMetric('low-ctr', 0, 50, 90); // zero consumption, old
    insertMetric('high-ctr', 20, 30, 1); // high consumption, recent
    insertBaseline('feature', 0.2);

    const results = [getDoc('low-ctr'), getDoc('high-ctr')];
    applyConsumptionRerank(results, db);

    // Live order should be preserved (shadow mode = no change to user)
    assert.equal(results[0].anchor, 'low-ctr', 'precondition: shadow mode preserves live BM25 order');

    // Shadow should store the WOULD-BE reranked order (high-ctr promoted to 0)
    // NOT the BM25 order (which would be low-ctr=0, high-ctr=1 — same as live)
    const ranking = lookupShadowRanking(results.map((r) => r.anchor));
    assert.ok(ranking, 'shadow ranking should exist');
    const shadowMap = Object.fromEntries(ranking.map((r) => [r.anchor, r.shadowRank]));
    assert.equal(shadowMap['high-ctr'], 0, 'shadow: high-ctr should be at reranked position 0 (would-be promoted)');
    assert.equal(shadowMap['low-ctr'], 1, 'shadow: low-ctr should be at reranked position 1 (would-be demoted)');
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
