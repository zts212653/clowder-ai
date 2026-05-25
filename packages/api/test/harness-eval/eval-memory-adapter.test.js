import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildMemoryVerdictHandoff } from '../../dist/infrastructure/harness-eval/eval-memory-adapter.js';

const memoryDomain = {
  domainId: 'eval:memory',
  displayName: 'Memory Recall & Library Health Eval',
  systemThreadId: 'thread_eval_memory',
  evalCat: { catId: 'opus47', handle: '@opus47', model: 'claude-opus-4-7' },
  frequency: 'daily',
  sourceAdapter: 'f200-f188-memory-eval',
  threadPolicy: {
    role: 'working-home',
    stateSot: 'registry',
    allowedContent: ['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'],
  },
  legacyScheduledTaskIds: ['memory-recall-digest'],
  handoffTargetResolver: { featureId: 'F200', ownerCatId: 'opus47', threadLookup: 'feature-thread' },
  sla: { acknowledgeHours: 48, reevalWithinHours: 168 },
};

// Fixtures match real RecallMetricsReport shape (packages/api/src/domains/memory/RecallMetricsComputer.ts)
const healthyRecallMetrics = {
  period: { fromMs: 1716508800000, toMs: 1717113600000, days: 7 },
  filters: {},
  totalEvents: 142,
  core: {
    consumedAt3: 0.65,
    consumedMRR: 0.72,
    reformulationRate: 0.15,
    searchAbandonRate: 0.08,
  },
  extended: {
    readthroughAt3: 0.55,
    firstConsumedRankMedian: 2,
    reformulationsBeforeConsumption: 1.3,
    reformulateAfterExposure: 0.05,
    grepFallbackRate: 0.12,
    tokenCostPerHit: 1200,
    consumedAnchorNotInPoolRate: 0.03,
    shadowConsumedMRR: null,
  },
  graph: {
    nonFirstSelectionRate: 0.18,
    traversalCompletion: 0.82,
  },
};

// Fixtures match real LibraryHealthMetrics shape (packages/api/src/domains/memory/f188-library-health.ts)
const healthyLibrary = {
  staleAnchors: { count: 2, items: [] },
  orphanEdges: { count: 3 },
  verificationDebt: { needsReviewCount: 8, escalatedCount: 1, trustedLegacyCount: 45 },
  searchQuality: {
    totalSearches: 350,
    zeroHitCount: 12,
    lowHitCount: 28,
    recentMisses: [],
  },
  replayDrift: { available: true, sampleCount: 50, avgSimilarity: 0.89 },
  knowledgeFeed: { pendingCount: 5, needsReviewCount: 2 },
};

describe('eval-memory-adapter', () => {
  it('builds keep_observe verdict when recall metrics are healthy', () => {
    const packet = buildMemoryVerdictHandoff({
      domain: memoryDomain,
      recallMetrics: healthyRecallMetrics,
      libraryHealth: healthyLibrary,
      noFindingRecord: { reason: 'All metrics within threshold', evidence: 'MRR 0.72 >= 0.5 threshold' },
    });

    assert.equal(packet.verdict, 'keep_observe');
    assert.equal(packet.domainId, 'eval:memory');
    assert.ok(packet.phenomenon.includes('No actionable memory findings'));
    assert.equal(packet.ownerAsk.targetFeatureId, 'F200');
    assert.equal(packet.ownerAsk.targetOwnerCatId, 'opus47');
  });

  it('builds fix verdict when a friction finding is present', () => {
    const unhealthyLibrary = {
      staleAnchors: { count: 12, items: [] },
      orphanEdges: { count: 25 },
      verificationDebt: { needsReviewCount: 40, escalatedCount: 5, trustedLegacyCount: 20 },
      searchQuality: { totalSearches: 200, zeroHitCount: 30, lowHitCount: 50, recentMisses: [] },
      replayDrift: { available: true, sampleCount: 50, avgSimilarity: 0.6 },
      knowledgeFeed: { pendingCount: 10, needsReviewCount: 5 },
    };
    const packet = buildMemoryVerdictHandoff({
      domain: memoryDomain,
      recallMetrics: healthyRecallMetrics,
      libraryHealth: unhealthyLibrary,
      finding: {
        id: 'mem-orphan-spike-2026-05-24',
        signal: { type: 'orphan_edge_spike', severity: 'medium', confidence: 0.8 },
        primaryLayer: 'graph_integrity',
        evidence: [
          { type: 'counter', anchor: 'library-health/orphan_edge_count', excerpt: '25 orphan edges detected' },
        ],
        proposedAction: [
          { action: 'repair-orphans', target: 'F188/orphan-edge-repair', rationale: 'Orphan count exceeds threshold' },
        ],
      },
    });

    assert.equal(packet.verdict, 'fix');
    assert.equal(packet.domainId, 'eval:memory');
    assert.ok(packet.phenomenon.includes('orphan_edge_spike'));
    // P1-2 fix: F188 finding must route to F188, not domain default F200
    assert.equal(packet.ownerAsk.targetFeatureId, 'F188');
    assert.equal(packet.harnessUnderEval.featureId, 'F188');
  });

  it('builds build verdict for instrument-gap findings', () => {
    const packet = buildMemoryVerdictHandoff({
      domain: memoryDomain,
      recallMetrics: healthyRecallMetrics,
      libraryHealth: healthyLibrary,
      finding: {
        id: 'mem-coverage-gap-2026-05-24',
        signal: { type: 'recall_coverage_gap', severity: 'low', confidence: 0.6 },
        primaryLayer: 'tool_gap',
        evidence: [
          {
            type: 'telemetry-gap',
            anchor: 'recall-metrics/attribution_clarity',
            excerpt: 'attribution clarity metric not yet tracked',
          },
        ],
        proposedAction: [
          {
            action: 'add-counter',
            target: 'recall-metrics/attribution_clarity',
            rationale: 'missing recall attribution metric',
          },
        ],
      },
    });

    assert.equal(packet.verdict, 'build');
  });

  it('rejects input when no recall events were recorded', () => {
    assert.throws(
      () =>
        buildMemoryVerdictHandoff({
          domain: memoryDomain,
          recallMetrics: {
            period: { fromMs: 0, toMs: 0, days: 7 },
            filters: {},
            totalEvents: 0,
            core: { consumedAt3: 0, consumedMRR: 0, reformulationRate: 0, searchAbandonRate: 0 },
            extended: {
              readthroughAt3: 0,
              firstConsumedRankMedian: 0,
              reformulationsBeforeConsumption: 0,
              reformulateAfterExposure: 0,
              grepFallbackRate: 0,
              tokenCostPerHit: 0,
              consumedAnchorNotInPoolRate: 0,
              shadowConsumedMRR: null,
            },
            graph: { nonFirstSelectionRate: 0, traversalCompletion: 0 },
          },
          libraryHealth: healthyLibrary,
          noFindingRecord: { reason: 'test', evidence: 'test' },
        }),
      /no recall events/i,
    );
  });

  it('rejects keep_observe without a no-finding record', () => {
    assert.throws(
      () =>
        buildMemoryVerdictHandoff({
          domain: memoryDomain,
          recallMetrics: healthyRecallMetrics,
          libraryHealth: healthyLibrary,
        }),
      /no-finding record is required/i,
    );
  });

  it('produces a packet that passes the verdict handoff contract', () => {
    const packet = buildMemoryVerdictHandoff({
      domain: memoryDomain,
      recallMetrics: healthyRecallMetrics,
      libraryHealth: healthyLibrary,
      noFindingRecord: { reason: 'All metrics within threshold', evidence: 'MRR 0.72 >= 0.5' },
    });

    // Verify all required contract fields are present
    assert.ok(packet.id.length > 0);
    assert.ok(packet.createdAt.length > 0);
    assert.ok(packet.phenomenon.length > 0);
    assert.ok(packet.harnessUnderEval.featureId.length > 0);
    assert.ok(packet.evidencePacket.snapshotRefs.length > 0);
    assert.ok(packet.evidencePacket.attributionRefs.length > 0);
    assert.ok(packet.evidencePacket.metricRefs.length > 0);
    assert.ok(packet.evidencePacket.sampleTraceRefs.length > 0);
    assert.ok(packet.rootCauseHypothesis.summary.length > 0);
    assert.ok(packet.counterarguments.length > 0);
    assert.ok(packet.acceptanceReevalPlan.nextEvalAt.length > 0);
  });

  it('includes library health metrics in evidence packet and trend', () => {
    const packet = buildMemoryVerdictHandoff({
      domain: memoryDomain,
      recallMetrics: healthyRecallMetrics,
      libraryHealth: healthyLibrary,
      noFindingRecord: { reason: 'All metrics within threshold', evidence: 'MRR 0.72 >= 0.5 threshold' },
    });

    // Library health metrics must appear in metricRefs
    assert.ok(packet.evidencePacket.metricRefs.some((r) => r.includes('orphan_edge')));
    assert.ok(packet.evidencePacket.metricRefs.some((r) => r.includes('stale_anchor')));
    assert.ok(packet.evidencePacket.metricRefs.some((r) => r.includes('verification_debt')));

    // Library health values must appear in trend current
    assert.equal(packet.dailyTrend.current.orphan_edge_count, 3);
    assert.equal(packet.dailyTrend.current.stale_anchor_count, 2);
    assert.equal(packet.dailyTrend.current.verification_debt_count, 8);
  });

  it('rejects finding with empty proposedAction array', () => {
    assert.throws(
      () =>
        buildMemoryVerdictHandoff({
          domain: memoryDomain,
          recallMetrics: healthyRecallMetrics,
          libraryHealth: healthyLibrary,
          finding: {
            id: 'mem-empty-action-2026-05-24',
            signal: { type: 'test_signal', severity: 'low', confidence: 0.5 },
            primaryLayer: 'graph_integrity',
            evidence: [{ type: 'counter', anchor: 'test', excerpt: 'test' }],
            proposedAction: [],
          },
        }),
      /proposedAction/i,
    );
  });

  it('rejects non-memory domain in memory verdict adapter', () => {
    const a2aDomain = {
      ...memoryDomain,
      domainId: 'eval:a2a',
    };
    assert.throws(
      () =>
        buildMemoryVerdictHandoff({
          domain: a2aDomain,
          recallMetrics: healthyRecallMetrics,
          libraryHealth: healthyLibrary,
          noFindingRecord: { reason: 'test', evidence: 'test' },
        }),
      /eval:memory/i,
    );
  });

  it('computes re-eval deadline from SLA window', () => {
    const packet = buildMemoryVerdictHandoff({
      domain: memoryDomain,
      recallMetrics: healthyRecallMetrics,
      libraryHealth: healthyLibrary,
      noFindingRecord: { reason: 'clean', evidence: 'clean' },
    });

    const created = Date.parse(packet.createdAt);
    const nextEval = Date.parse(packet.acceptanceReevalPlan.nextEvalAt);
    const hours = (nextEval - created) / 3_600_000;
    assert.equal(hours, 168); // matches SLA reevalWithinHours
  });
});
