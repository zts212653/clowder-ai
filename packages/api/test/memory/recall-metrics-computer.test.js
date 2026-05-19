import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

function insertEvent(db, overrides) {
  const defaults = {
    recall_id: `r-${Math.random()}`,
    cat_id: 'opus',
    invocation_id: 'inv-1',
    tool_name: 'search_evidence',
    query: 'test',
    mode: 'hybrid',
    scope: 'docs',
    candidates_json: '[]',
    consumed_json: '[]',
    reformulated: 0,
    fell_back_to_grep: 0,
    abandoned: 0,
    next_graph_resolve_after_read: 0,
    token_cost: 0,
    timestamp: Date.now(),
  };
  const e = { ...defaults, ...overrides };
  db.prepare(`INSERT INTO recall_events
    (recall_id, cat_id, invocation_id, tool_name, query, mode, scope,
     candidates_json, consumed_json, reformulated, fell_back_to_grep,
     abandoned, next_graph_resolve_after_read, token_cost, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    e.recall_id,
    e.cat_id,
    e.invocation_id,
    e.tool_name,
    e.query,
    e.mode,
    e.scope,
    e.candidates_json,
    e.consumed_json,
    e.reformulated,
    e.fell_back_to_grep,
    e.abandoned,
    e.next_graph_resolve_after_read,
    e.token_cost,
    e.timestamp,
  );
}

describe('RecallMetricsComputer', () => {
  let RecallMetricsComputer;
  let Database;
  let db;

  beforeEach(async () => {
    Database = (await import('better-sqlite3')).default;
    const schema = await import('../../dist/domains/memory/schema.js');
    const mod = await import(`../../dist/domains/memory/RecallMetricsComputer.js?v=${Date.now()}`);
    RecallMetricsComputer = mod.RecallMetricsComputer;

    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(schema.SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    schema.applyMigrations(db);
  });

  it('AC-B1: consumedAt3 = fraction of events where top-3 candidate consumed', () => {
    insertEvent(db, {
      recall_id: 'r1',
      candidates_json: JSON.stringify([{ anchor: 'A', rank: 0 }]),
      consumed_json: JSON.stringify([{ anchor: 'A', rank: 0, method: 'Read' }]),
    });
    insertEvent(db, {
      recall_id: 'r2',
      candidates_json: JSON.stringify([{ anchor: 'B', rank: 0 }]),
      consumed_json: '[]',
      abandoned: 1,
    });

    const computer = new RecallMetricsComputer(db);
    const report = computer.computeMetrics({ days: 1 });
    assert.equal(report.core.consumedAt3, 0.5);
  });

  it('AC-B1: consumedMRR = mean of 1/first_consumed_position', () => {
    insertEvent(db, {
      recall_id: 'r1',
      candidates_json: JSON.stringify([{ anchor: 'A', rank: 0 }]),
      consumed_json: JSON.stringify([{ anchor: 'A', rank: 0, method: 'Read' }]),
    });
    insertEvent(db, {
      recall_id: 'r2',
      candidates_json: JSON.stringify([
        { anchor: 'X', rank: 0 },
        { anchor: 'Y', rank: 1 },
        { anchor: 'Z', rank: 2 },
      ]),
      consumed_json: JSON.stringify([{ anchor: 'Z', rank: 2, method: 'Read' }]),
    });

    const computer = new RecallMetricsComputer(db);
    const report = computer.computeMetrics({ days: 1 });
    // rank=0 → position=1 → 1/1=1.0; rank=2 → position=3 → 1/3
    // MRR = (1.0 + 1/3) / 2 = 2/3
    assert.ok(Math.abs(report.core.consumedMRR - 2 / 3) < 0.001);
  });

  it('AC-B1: reformulationRate and searchAbandonRate', () => {
    insertEvent(db, { recall_id: 'r1', reformulated: 1 });
    insertEvent(db, { recall_id: 'r2', abandoned: 1 });
    insertEvent(db, { recall_id: 'r3' });

    const computer = new RecallMetricsComputer(db);
    const report = computer.computeMetrics({ days: 1 });
    assert.ok(Math.abs(report.core.reformulationRate - 1 / 3) < 0.001);
    assert.ok(Math.abs(report.core.searchAbandonRate - 1 / 3) < 0.001);
  });

  it('AC-B3: tokenCostPerHit aggregated by catId', () => {
    insertEvent(db, {
      recall_id: 'r1',
      cat_id: 'opus',
      token_cost: 500,
      consumed_json: JSON.stringify([{ anchor: 'A', rank: 0, method: 'Read' }]),
    });
    insertEvent(db, {
      recall_id: 'r2',
      cat_id: 'opus',
      token_cost: 300,
      consumed_json: JSON.stringify([{ anchor: 'B', rank: 0, method: 'Read' }]),
    });
    insertEvent(db, { recall_id: 'r3', cat_id: 'codex', token_cost: 200, consumed_json: '[]', abandoned: 1 });

    const computer = new RecallMetricsComputer(db);
    const opusReport = computer.computeMetrics({ days: 1, catId: 'opus' });
    assert.equal(opusReport.extended.tokenCostPerHit, 400);
  });

  it('AC-B4: graphNonFirstSelectionRate', () => {
    insertEvent(db, {
      recall_id: 'r1',
      tool_name: 'graph_resolve',
      candidates_json: JSON.stringify([
        { anchor: 'A', rank: 0 },
        { anchor: 'B', rank: 1 },
      ]),
      consumed_json: JSON.stringify([{ anchor: 'B', rank: 1, method: 'Read' }]),
    });
    insertEvent(db, {
      recall_id: 'r2',
      tool_name: 'graph_resolve',
      candidates_json: JSON.stringify([{ anchor: 'C', rank: 0 }]),
      consumed_json: JSON.stringify([{ anchor: 'C', rank: 0, method: 'Read' }]),
    });

    const computer = new RecallMetricsComputer(db);
    const report = computer.computeMetrics({ days: 1 });
    assert.equal(report.graph.nonFirstSelectionRate, 0.5);
  });

  it('AC-B4: graphTraversalCompletion', () => {
    insertEvent(db, {
      recall_id: 'r1',
      tool_name: 'graph_resolve',
      next_graph_resolve_after_read: 1,
      consumed_json: JSON.stringify([{ anchor: 'A', rank: 0, method: 'Read' }]),
    });
    insertEvent(db, {
      recall_id: 'r2',
      tool_name: 'graph_resolve',
      next_graph_resolve_after_read: 0,
      consumed_json: JSON.stringify([{ anchor: 'B', rank: 0, method: 'Read' }]),
    });

    const computer = new RecallMetricsComputer(db);
    const report = computer.computeMetrics({ days: 1 });
    assert.equal(report.graph.traversalCompletion, 0.5);
  });

  it('P2-3 regression: traversalCompletion counts traversals without consumption', () => {
    insertEvent(db, {
      recall_id: 'r-traverse-no-consume',
      tool_name: 'graph_resolve',
      next_graph_resolve_after_read: 1,
      consumed_json: '[]',
    });
    insertEvent(db, {
      recall_id: 'r-traverse-with-consume',
      tool_name: 'graph_resolve',
      next_graph_resolve_after_read: 1,
      consumed_json: JSON.stringify([{ anchor: 'A', rank: 0, method: 'Read' }]),
    });
    insertEvent(db, {
      recall_id: 'r-no-traverse',
      tool_name: 'graph_resolve',
      next_graph_resolve_after_read: 0,
      consumed_json: '[]',
    });

    const computer = new RecallMetricsComputer(db);
    const report = computer.computeMetrics({ days: 1 });
    assert.equal(
      report.graph.traversalCompletion,
      2 / 3,
      'both traversals should count (2/3), not just the one with consumption (1/3)',
    );
  });

  it('filters by time window', () => {
    const now = Date.now();
    insertEvent(db, { recall_id: 'r1', timestamp: now, abandoned: 1 });
    insertEvent(db, { recall_id: 'r2', timestamp: now - 8 * 86_400_000, abandoned: 1 });

    const computer = new RecallMetricsComputer(db);
    const report7d = computer.computeMetrics({ days: 7 });
    assert.equal(report7d.totalEvents, 1);
    const report30d = computer.computeMetrics({ days: 30 });
    assert.equal(report30d.totalEvents, 2);
  });

  it('AC-B2: refreshAnchorMetrics persists popularity + dormancy', () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      insertEvent(db, {
        recall_id: `r-a-${i}`,
        timestamp: now - i * 86_400_000,
        candidates_json: JSON.stringify([{ anchor: 'A', rank: 0 }]),
        consumed_json: JSON.stringify([{ anchor: 'A', rank: 0, method: 'Read' }]),
      });
    }
    for (let i = 0; i < 2; i++) {
      insertEvent(db, {
        recall_id: `r-b-${i}`,
        timestamp: now - i * 86_400_000,
        candidates_json: JSON.stringify([{ anchor: 'B', rank: 1 }]),
        consumed_json: '[]',
        abandoned: 1,
      });
    }

    const computer = new RecallMetricsComputer(db);
    computer.refreshAnchorMetrics();

    const anchorA = db.prepare('SELECT * FROM anchor_recall_metrics WHERE anchor = ?').get('A');
    assert.ok(anchorA);
    assert.equal(anchorA.consumed_count_30d, 3);
    assert.equal(anchorA.exposure_count_30d, 3);
    assert.equal(anchorA.dormancy_days, 0);

    const anchorB = db.prepare('SELECT * FROM anchor_recall_metrics WHERE anchor = ?').get('B');
    assert.ok(anchorB);
    assert.equal(anchorB.consumed_count_30d, 0);
    assert.equal(anchorB.exposure_count_30d, 2);
    assert.ok(anchorB.dormancy_days === null);
  });

  it('AC-B2: getPopularAnchors returns ranked list', () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      insertEvent(db, {
        recall_id: `r-pop-${i}`,
        timestamp: now,
        candidates_json: JSON.stringify([{ anchor: 'HOT', rank: 0 }]),
        consumed_json: JSON.stringify([{ anchor: 'HOT', rank: 0, method: 'Read' }]),
      });
    }
    insertEvent(db, {
      recall_id: 'r-cold',
      timestamp: now,
      candidates_json: JSON.stringify([{ anchor: 'COLD', rank: 0 }]),
      consumed_json: JSON.stringify([{ anchor: 'COLD', rank: 0, method: 'Read' }]),
    });

    const computer = new RecallMetricsComputer(db);
    computer.refreshAnchorMetrics();
    const popular = computer.getPopularAnchors(10);
    assert.equal(popular[0].anchor, 'HOT');
    assert.equal(popular[0].consumedCount30d, 5);
  });

  it('AC-C7: refreshGlobalCtrBaseline computes per-kind mean CTR', () => {
    const now = Date.now();
    db.prepare(
      "INSERT OR IGNORE INTO evidence_docs (anchor, kind, status, title, summary, updated_at, authority) VALUES (?, ?, 'active', ?, '', datetime('now'), 'observed')",
    ).run('feat-A', 'feature', 'feat-A');
    db.prepare(
      "INSERT OR IGNORE INTO evidence_docs (anchor, kind, status, title, summary, updated_at, authority) VALUES (?, ?, 'active', ?, '', datetime('now'), 'observed')",
    ).run('feat-B', 'feature', 'feat-B');
    db.prepare(
      "INSERT OR IGNORE INTO evidence_docs (anchor, kind, status, title, summary, updated_at, authority) VALUES (?, ?, 'active', ?, '', datetime('now'), 'observed')",
    ).run('plan-A', 'plan', 'plan-A');

    for (let i = 0; i < 10; i++) {
      insertEvent(db, {
        recall_id: `r-fa-${i}`,
        timestamp: now,
        candidates_json: JSON.stringify([{ anchor: 'feat-A', rank: 0 }]),
        consumed_json: i < 5 ? JSON.stringify([{ anchor: 'feat-A', rank: 0, method: 'Read' }]) : '[]',
      });
    }
    for (let i = 0; i < 10; i++) {
      insertEvent(db, {
        recall_id: `r-fb-${i}`,
        timestamp: now,
        candidates_json: JSON.stringify([{ anchor: 'feat-B', rank: 0 }]),
        consumed_json: i < 3 ? JSON.stringify([{ anchor: 'feat-B', rank: 0, method: 'Read' }]) : '[]',
      });
    }
    for (let i = 0; i < 10; i++) {
      insertEvent(db, {
        recall_id: `r-pa-${i}`,
        timestamp: now,
        candidates_json: JSON.stringify([{ anchor: 'plan-A', rank: 0 }]),
        consumed_json: i < 8 ? JSON.stringify([{ anchor: 'plan-A', rank: 0, method: 'Read' }]) : '[]',
      });
    }

    const computer = new RecallMetricsComputer(db);
    computer.refreshAnchorMetrics();
    computer.refreshGlobalCtrBaseline();

    const feature = db.prepare('SELECT * FROM global_ctr_baseline WHERE doc_kind = ?').get('feature');
    assert.ok(feature, 'should have feature baseline');
    assert.equal(feature.mean_ctr, 0.4, 'feature: (5/10 + 3/10) / 2 = 0.4');
    assert.equal(feature.sample_count, 2);

    const plan = db.prepare('SELECT * FROM global_ctr_baseline WHERE doc_kind = ?').get('plan');
    assert.ok(plan, 'should have plan baseline');
    assert.equal(plan.mean_ctr, 0.8, 'plan: 8/10 = 0.8');
    assert.equal(plan.sample_count, 1);
  });

  it('returns empty report for no events', () => {
    const computer = new RecallMetricsComputer(db);
    const report = computer.computeMetrics({ days: 7 });
    assert.equal(report.totalEvents, 0);
    assert.equal(report.core.consumedAt3, 0);
    assert.equal(report.core.consumedMRR, 0);
  });

  // ── P1 regression tests ──────────────────────────────────────────

  it('P1-1 regression: 0-based rank does not produce Infinity MRR', () => {
    insertEvent(db, {
      recall_id: 'r-zero',
      candidates_json: JSON.stringify([{ anchor: 'TOP', rank: 0 }]),
      consumed_json: JSON.stringify([{ anchor: 'TOP', rank: 0, method: 'Read' }]),
    });

    const computer = new RecallMetricsComputer(db);
    const report = computer.computeMetrics({ days: 1 });
    assert.ok(Number.isFinite(report.core.consumedMRR), 'MRR must be finite, not Infinity');
    assert.equal(report.core.consumedMRR, 1.0);
    assert.equal(report.core.consumedAt3, 1.0);
  });

  it('P1-2 regression: refreshAnchorMetrics cleans stale anchors outside window', () => {
    const now = Date.now();
    const computer = new RecallMetricsComputer(db);

    insertEvent(db, {
      recall_id: 'r-within',
      timestamp: now,
      candidates_json: JSON.stringify([{ anchor: 'STALE', rank: 0 }]),
      consumed_json: JSON.stringify([{ anchor: 'STALE', rank: 0, method: 'Read' }]),
    });
    computer.refreshAnchorMetrics();
    const before = db.prepare('SELECT * FROM anchor_recall_metrics WHERE anchor = ?').get('STALE');
    assert.ok(before, 'STALE should exist after first refresh');

    db.prepare('DELETE FROM recall_events WHERE recall_id = ?').run('r-within');
    insertEvent(db, {
      recall_id: 'r-live',
      timestamp: now,
      candidates_json: JSON.stringify([{ anchor: 'LIVE', rank: 0 }]),
      consumed_json: JSON.stringify([{ anchor: 'LIVE', rank: 0, method: 'Read' }]),
    });
    computer.refreshAnchorMetrics();

    const staleAfter = db.prepare('SELECT * FROM anchor_recall_metrics WHERE anchor = ?').get('STALE');
    assert.equal(staleAfter, undefined, 'STALE should be cleaned after refresh when outside window');
    const liveAfter = db.prepare('SELECT * FROM anchor_recall_metrics WHERE anchor = ?').get('LIVE');
    assert.ok(liveAfter, 'LIVE should exist after refresh');
  });

  it('P1-4 regression: reformulationsBeforeConsumption = 0 when first search succeeds', () => {
    insertEvent(db, {
      recall_id: 'r-first-hit',
      invocation_id: 'inv-first',
      candidates_json: JSON.stringify([{ anchor: 'A', rank: 0 }]),
      consumed_json: JSON.stringify([{ anchor: 'A', rank: 0, method: 'Read' }]),
    });

    const computer = new RecallMetricsComputer(db);
    const report = computer.computeMetrics({ days: 1 });
    assert.equal(
      report.extended.reformulationsBeforeConsumption,
      0,
      'first-search success should contribute 0 reformulations, not 1',
    );
  });

  it('P1-4b regression: reformulationsBeforeConsumption counts only searches before first hit', () => {
    const now = Date.now();
    insertEvent(db, {
      recall_id: 'r-miss',
      invocation_id: 'inv-reform',
      timestamp: now - 2000,
      candidates_json: JSON.stringify([{ anchor: 'X', rank: 0 }]),
      consumed_json: '[]',
      reformulated: 1,
    });
    insertEvent(db, {
      recall_id: 'r-hit',
      invocation_id: 'inv-reform',
      timestamp: now - 1000,
      candidates_json: JSON.stringify([{ anchor: 'Y', rank: 0 }]),
      consumed_json: JSON.stringify([{ anchor: 'Y', rank: 0, method: 'Read' }]),
    });

    const computer = new RecallMetricsComputer(db);
    const report = computer.computeMetrics({ days: 1 });
    assert.equal(
      report.extended.reformulationsBeforeConsumption,
      1,
      'one reformulation before the successful second search',
    );
  });

  it('P2-1 regression: firstConsumedRankMedian is true median for even sample', () => {
    insertEvent(db, {
      recall_id: 'r-rank1',
      candidates_json: JSON.stringify([{ anchor: 'A', rank: 0 }]),
      consumed_json: JSON.stringify([{ anchor: 'A', rank: 0, method: 'Read' }]),
    });
    insertEvent(db, {
      recall_id: 'r-rank2',
      candidates_json: JSON.stringify([{ anchor: 'B', rank: 2 }]),
      consumed_json: JSON.stringify([{ anchor: 'B', rank: 2, method: 'Read' }]),
    });

    const computer = new RecallMetricsComputer(db);
    const report = computer.computeMetrics({ days: 1 });
    // ranks 0,2 → positions 1,3 → sorted [1,3] → true median = (1+3)/2 = 2
    assert.equal(report.extended.firstConsumedRankMedian, 2, 'even-length median should average two middle values');
  });

  it('P1-5 regression: dormancy survives beyond 30d window via full-history lastConsumedAt', () => {
    const now = Date.now();
    insertEvent(db, {
      recall_id: 'r-old',
      timestamp: now - 45 * 86_400_000,
      candidates_json: JSON.stringify([{ anchor: 'OLD', rank: 0 }]),
      consumed_json: JSON.stringify([{ anchor: 'OLD', rank: 0, method: 'Read' }]),
    });
    insertEvent(db, {
      recall_id: 'r-recent',
      timestamp: now,
      candidates_json: JSON.stringify([{ anchor: 'RECENT', rank: 0 }]),
      consumed_json: JSON.stringify([{ anchor: 'RECENT', rank: 0, method: 'Read' }]),
    });

    const computer = new RecallMetricsComputer(db);
    computer.refreshAnchorMetrics();

    const old = db.prepare('SELECT * FROM anchor_recall_metrics WHERE anchor = ?').get('OLD');
    assert.ok(old, 'OLD anchor consumed 45d ago should still appear via full-history scan');
    assert.ok(old.dormancy_days >= 44, `dormancy should be ~45, got ${old.dormancy_days}`);
    assert.equal(old.consumed_count_30d, 0, '30d consumed count should be 0 (outside window)');
    assert.equal(old.exposure_count_30d, 0, '30d exposure count should be 0 (outside window)');

    const recent = db.prepare('SELECT * FROM anchor_recall_metrics WHERE anchor = ?').get('RECENT');
    assert.ok(recent);
    assert.equal(recent.dormancy_days, 0);
    assert.equal(recent.consumed_count_30d, 1);
  });

  it('P2-2 regression: reformulateAfterExposure requires candidates to have been shown', () => {
    insertEvent(db, {
      recall_id: 'r-no-exposure',
      candidates_json: '[]',
      consumed_json: '[]',
      reformulated: 1,
    });
    insertEvent(db, {
      recall_id: 'r-with-exposure',
      candidates_json: JSON.stringify([{ anchor: 'A', rank: 0 }]),
      consumed_json: '[]',
      reformulated: 1,
    });

    const computer = new RecallMetricsComputer(db);
    const report = computer.computeMetrics({ days: 1 });
    assert.equal(
      report.extended.reformulateAfterExposure,
      0.5,
      'only event with candidates should count as after-exposure reformulation (1/2)',
    );
  });

  it('AC-C6: consumedAnchorNotInPoolRate tracks consumed-but-not-in-candidates', () => {
    insertEvent(db, {
      recall_id: 'r-miss',
      candidates_json: JSON.stringify([{ anchor: 'A', rank: 0 }]),
      consumed_json: JSON.stringify([{ anchor: 'X', rank: -1, method: 'Read' }]),
    });
    insertEvent(db, {
      recall_id: 'r-hit',
      candidates_json: JSON.stringify([{ anchor: 'B', rank: 0 }]),
      consumed_json: JSON.stringify([{ anchor: 'B', rank: 0, method: 'Read' }]),
    });

    const computer = new RecallMetricsComputer(db);
    const report = computer.computeMetrics({ days: 1 });
    assert.equal(report.extended.consumedAnchorNotInPoolRate, 0.5);
  });

  it('AC-C6: consumedAnchorNotInPoolRate is 0 when all consumed in pool', () => {
    insertEvent(db, {
      recall_id: 'r-all-hit',
      candidates_json: JSON.stringify([
        { anchor: 'A', rank: 0 },
        { anchor: 'B', rank: 1 },
      ]),
      consumed_json: JSON.stringify([{ anchor: 'A', rank: 0, method: 'Read' }]),
    });

    const computer = new RecallMetricsComputer(db);
    const report = computer.computeMetrics({ days: 1 });
    assert.equal(report.extended.consumedAnchorNotInPoolRate, 0);
  });

  it('AC-C4: shadowConsumedMRR computed from shadow_ranking_json', () => {
    const shadowRanking = [
      { anchor: 'A', shadowRank: 1 },
      { anchor: 'B', shadowRank: 0 },
    ];
    insertEvent(db, {
      recall_id: 'r-shadow-1',
      candidates_json: JSON.stringify([
        { anchor: 'A', rank: 0 },
        { anchor: 'B', rank: 1 },
      ]),
      consumed_json: JSON.stringify([{ anchor: 'A', rank: 0, method: 'Read' }]),
    });
    db.prepare('UPDATE recall_events SET shadow_ranking_json = ? WHERE recall_id = ?').run(
      JSON.stringify(shadowRanking),
      'r-shadow-1',
    );

    const computer = new RecallMetricsComputer(db);
    const report = computer.computeMetrics({ days: 1 });
    assert.equal(report.core.consumedMRR, 1.0, 'original: A at rank 0 → MRR=1/(0+1)=1.0');
    assert.equal(report.extended.shadowConsumedMRR, 0.5, 'shadow: A at shadowRank 1 → MRR=1/(1+1)=0.5');
  });

  it('AC-C4: shadowConsumedMRR is null when no shadow data', () => {
    insertEvent(db, {
      recall_id: 'r-no-shadow',
      candidates_json: JSON.stringify([{ anchor: 'A', rank: 0 }]),
      consumed_json: JSON.stringify([{ anchor: 'A', rank: 0, method: 'Read' }]),
    });

    const computer = new RecallMetricsComputer(db);
    const report = computer.computeMetrics({ days: 1 });
    assert.equal(report.extended.shadowConsumedMRR, null);
  });

  it('P1-3 regression: extended report uses grepFallbackRate field name', () => {
    insertEvent(db, {
      recall_id: 'r-fb1',
      candidates_json: JSON.stringify([{ anchor: 'A', rank: 0 }]),
      fell_back_to_grep: 1,
    });
    insertEvent(db, {
      recall_id: 'r-fb2',
      candidates_json: JSON.stringify([{ anchor: 'B', rank: 0 }]),
      fell_back_to_grep: 0,
    });

    const computer = new RecallMetricsComputer(db);
    const report = computer.computeMetrics({ days: 1 });
    assert.ok('grepFallbackRate' in report.extended, 'field should be named grepFallbackRate');
    assert.equal(report.extended.grepFallbackRate, 0.5);
    assert.equal(report.extended.fallbackAfterHighHitRate, undefined, 'old field name should not exist');
  });
});
