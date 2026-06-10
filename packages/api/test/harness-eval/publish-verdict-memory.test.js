import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createMemoryGeneratorAdapter } from '../../dist/infrastructure/harness-eval/publish-verdict/memory-generator-adapter.js';
import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { setupHarnessFeedback } from './eval-manual-trigger-fixtures.js';
import { buildPacket } from './publish-verdict-fixtures.js';

/**
 * F192 publish_verdict eval:memory wire-up — end-to-end test.
 *
 * Mirrors `publish-verdict-capability-wakeup.test.js`. Validates:
 *   - Handler accepts eval:memory + memory-recall-snapshot sourceRefs
 *   - Handler dispatches to memory generator adapter via deps.generator
 *   - sourceRefs.kind ↔ packet.domainId cross-check enforces
 *     'memory-recall-snapshot' for eval:memory
 *   - Adapter resolves metrics via provider port → writes
 *     snapshot.json / attribution.json / provenance.json + raw inputs +
 *     verdict.md inside isolated worktree
 *   - Provider failure modes (no_metrics_in_window, provider throws)
 *     map to 4xx, not 500 generator_failed
 *   - 501 still returned when domain has no generator wired
 */

/** @type {string} */
let root;

before(() => {
  root = setupHarnessFeedback();
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function buildMemoryPacket(overrides = {}) {
  return buildPacket({
    id: 'vhp-mem-e2e-test',
    domainId: 'eval:memory',
    harnessUnderEval: { featureId: 'F200', componentId: 'memory-recall', name: 'memory-recall' },
    ownerAsk: { targetFeatureId: 'F200', targetOwnerCatId: 'opus-47', requestedAction: 'observe' },
    evidencePacket: {
      snapshotRefs: ['placeholder:will-be-overridden'],
      attributionRefs: ['placeholder:will-be-overridden'],
      metricRefs: ['consumed_mrr', 'consumed_at_3'],
      sampleTraceRefs: ['recall:trace-001'],
    },
    ...overrides,
  });
}

function buildRecallMetrics(overrides = {}) {
  // Mirrors RecallMetricsReport shape (packages/api/src/domains/memory/RecallMetricsComputer.ts)
  return {
    period: { fromMs: 1780000000000, toMs: 1782592000000, days: 30 },
    filters: {},
    totalEvents: 240,
    core: {
      consumedAt3: 0.42,
      consumedMRR: 0.31,
      reformulationRate: 0.12,
      searchAbandonRate: 0.18,
    },
    extended: {
      readthroughAt3: 0.55,
      firstConsumedRankMedian: 2,
      reformulationsBeforeConsumption: 0.9,
      reformulateAfterExposure: 0.07,
      grepFallbackRate: 0.09,
      tokenCostPerHit: 1230,
      consumedAnchorNotInPoolRate: 0.04,
      shadowConsumedMRR: 0.31,
      liveOnShadowSubsetMRR: 0.31,
    },
    graph: {
      nonFirstSelectionRate: 0.13,
      traversalCompletion: 0.0,
    },
    ...overrides,
  };
}

function buildLibraryHealth(overrides = {}) {
  return {
    staleAnchors: { count: 0, items: [] },
    orphanEdges: { count: 0 },
    verificationDebt: { needsReviewCount: 0, escalatedCount: 0, trustedLegacyCount: 0 },
    searchQuality: { totalSearches: 100, zeroHitCount: 2, lowHitCount: 5, recentMisses: [] },
    replayDrift: { available: false, sampleCount: 0, avgSimilarity: null },
    knowledgeFeed: { pendingCount: 0, needsReviewCount: 0 },
    ...overrides,
  };
}

describe('handlePublishVerdict end-to-end with eval:memory generator', () => {
  it('happy path: handler dispatches to memory adapter, returns verdict path + commit/PR', async () => {
    const provider = {
      resolve: async () => ({
        recallMetrics: buildRecallMetrics(),
        libraryHealth: buildLibraryHealth(),
      }),
    };
    const memGenerator = createMemoryGeneratorAdapter(provider);

    /** @type {string} */
    let isoStub;
    const mockGitPublisher = {
      async publishOnIsolatedWorktree(opts) {
        isoStub = join(root, '..', 'mem-e2e-iso-stub');
        // Mirror the registry into isolated worktree so loadDomains() works
        mkdirSync(join(isoStub, 'docs', 'harness-feedback', 'eval-domains'), { recursive: true });
        writeFileSync(
          join(isoStub, 'docs', 'harness-feedback', 'eval-domains', 'eval-memory.yaml'),
          readFileSync(join(root, 'eval-domains', 'eval-memory.yaml'), 'utf8'),
        );
        const stageResult = await opts.stage(isoStub);
        return {
          commitSha: 'mem-sha-1234',
          prUrl: 'https://github.com/zts212653/clowder-ai/pull/9100',
          stageResult,
        };
      },
    };

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, gitPublisher: mockGitPublisher, generator: memGenerator },
      {
        packet: buildMemoryPacket(),
        domain: 'eval:memory',
        catId: 'opus-47',
        sourceRefs: {
          kind: 'memory-recall-snapshot',
          windowDays: 30,
        },
      },
    );

    assert.ok(!('error' in result), `expected success, got: ${JSON.stringify(result)}`);
    assert.equal(result.commitSha, 'mem-sha-1234');
    assert.equal(result.prUrl, 'https://github.com/zts212653/clowder-ai/pull/9100');
    assert.equal(result.verdictPath, 'docs/harness-feedback/verdicts/vhp-mem-e2e-test.md');
    assert.equal(result.bundleDir, 'docs/harness-feedback/bundles/vhp-mem-e2e-test');

    // Verify generator wrote bundle artifacts inside isolated worktree
    const isoBundle = join(isoStub, 'docs', 'harness-feedback', 'bundles', 'vhp-mem-e2e-test');
    assert.ok(existsSync(join(isoBundle, 'snapshot.json')), 'snapshot.json must be written');
    assert.ok(existsSync(join(isoBundle, 'attribution.json')), 'attribution.json must be written');
    assert.ok(existsSync(join(isoBundle, 'provenance.json')), 'provenance.json must be written');
    const provenance = JSON.parse(readFileSync(join(isoBundle, 'provenance.json'), 'utf8'));
    assert.equal(provenance.verdictId, 'vhp-mem-e2e-test');
    assert.equal(provenance.generator.name, 'eval-memory-live-verdict');
    assert.ok(Array.isArray(provenance.rawInputs), 'provenance.rawInputs must be array');
    assert.ok(provenance.rawInputs.length >= 2, 'must reference >= 2 raw input files (metrics + health)');
    for (const r of provenance.rawInputs) {
      assert.ok(typeof r.path === 'string' && r.path.length > 0, 'rawInput path must be non-empty string');
      assert.match(r.sha256, /^[0-9a-f]{64}$/, 'rawInput sha256 must be 64 hex chars');
    }

    const snapshot = JSON.parse(readFileSync(join(isoBundle, 'snapshot.json'), 'utf8'));
    assert.equal(snapshot.featureId, 'F200');
    assert.equal(snapshot.verdictId, 'vhp-mem-e2e-test');
    // 砚砚-style invariant: recall metrics carried into snapshot bundle for reviewer audit
    assert.equal(snapshot.recallMetrics.totalEvents, 240);
    assert.equal(snapshot.recallMetrics.core.consumedMRR, 0.31);

    // verdict.md exists at <iso>/docs/harness-feedback/verdicts/<id>.md
    const isoVerdict = join(isoStub, 'docs', 'harness-feedback', 'verdicts', 'vhp-mem-e2e-test.md');
    assert.ok(existsSync(isoVerdict), 'verdict.md must be written');
    const md = readFileSync(isoVerdict, 'utf8');
    assert.match(md, /vhp-mem-e2e-test/, 'verdict.md must contain verdict id');
    assert.match(md, /keep_observe/, 'verdict.md must contain verdict outcome');

    rmSync(isoStub, { recursive: true, force: true });
  });

  // Cloud Codex R5 P1: actionable verdict (fix/build/delete_sunset) path must succeed
  // end-to-end — generator writes attribution.json findings whose evidence anchors
  // match bundled snapshot components/metrics. Keep-observe path goes through
  // noFindingRecord branch and silently skips this invariant.
  it('actionable verdict (fix) path: attribution evidence anchors match bundled snapshot', async () => {
    const provider = {
      resolve: async () => ({
        recallMetrics: buildRecallMetrics(),
        libraryHealth: buildLibraryHealth(),
      }),
    };
    const memGenerator = createMemoryGeneratorAdapter(provider);

    /** @type {string} */
    let isoStub;
    const mockGitPublisher = {
      async publishOnIsolatedWorktree(opts) {
        isoStub = join(root, '..', 'mem-e2e-actionable-iso');
        rmSync(isoStub, { recursive: true, force: true }); // idempotent — clean leftover from prior runs
        mkdirSync(join(isoStub, 'docs', 'harness-feedback', 'eval-domains'), { recursive: true });
        writeFileSync(
          join(isoStub, 'docs', 'harness-feedback', 'eval-domains', 'eval-memory.yaml'),
          readFileSync(join(root, 'eval-domains', 'eval-memory.yaml'), 'utf8'),
        );
        await opts.stage(isoStub);
        return { commitSha: 'mem-actionable-sha', prUrl: 'https://github.com/zts212653/clowder-ai/pull/9101' };
      },
    };

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, gitPublisher: mockGitPublisher, generator: memGenerator },
      {
        packet: buildMemoryPacket({
          id: 'vhp-mem-actionable-fix',
          verdict: 'fix',
          phenomenon: 'recall MRR sustained below threshold for 7 days',
          rootCauseHypothesis: {
            summary: 'graph traversal exhaustion path missing',
            confidence: 'medium',
            alternatives: ['fragmented anchor pool'],
          },
          dailyTrend: {
            window: '7d',
            current: { consumed_mrr: 0.18 },
            baseline: { consumed_mrr: 0.31 },
            threshold: { consumed_mrr: 0.25 },
            direction: 'regressed',
          },
        }),
        domain: 'eval:memory',
        catId: 'opus-47',
        sourceRefs: { kind: 'memory-recall-snapshot', windowDays: 30 },
      },
    );

    // RED expectation: handler MUST NOT return 500 generator_failed with anchor-mismatch.
    // (Cloud Codex R5 P1: pre-fix, this hits resolveA2aEvidenceBundle's
    // 'attribution finding must include at least one bundled component evidence anchor'.)
    assert.ok(!('error' in result), `expected success, got: ${JSON.stringify(result)}`);
    assert.equal(result.commitSha, 'mem-actionable-sha');

    // Verify attribution.json findings carry component-prefixed anchors
    const isoBundle = join(isoStub, 'docs', 'harness-feedback', 'bundles', 'vhp-mem-actionable-fix');
    const attribution = JSON.parse(readFileSync(join(isoBundle, 'attribution.json'), 'utf8'));
    assert.equal(attribution.findings.length, 1, 'actionable verdict must produce 1 finding');
    const finding = attribution.findings[0];
    assert.ok(finding.attribution.evidence.length >= 1, 'finding must have >= 1 evidence anchor');
    for (const evidence of finding.attribution.evidence) {
      assert.match(
        evidence.anchor,
        /^memory-recall(\/|$)/,
        `evidence anchor '${evidence.anchor}' must start with 'memory-recall' component id`,
      );
    }

    // Verify the verdict markdown rendered the fix verdict
    const isoVerdict = join(isoStub, 'docs', 'harness-feedback', 'verdicts', 'vhp-mem-actionable-fix.md');
    const md = readFileSync(isoVerdict, 'utf8');
    assert.match(md, /`fix`/, 'verdict.md must render `fix` verdict outcome');

    rmSync(isoStub, { recursive: true, force: true });
  });

  // Cloud Codex R9 P1: memory verdicts must support cross-feature handoff (e.g.
  // F188/orphan-edge-repair finding hands off to F188, not the domain default F200).
  // `eval-memory-adapter.ts:resolveHandoffFeatureId` explicitly designs for this; the
  // earlier generator guard forcing packet.featureId === domain default broke that
  // contract and rejected actionable library-health verdicts before they could publish.
  it('cross-feature handoff: F188 actionable verdict publishes despite domain default F200', async () => {
    const provider = {
      resolve: async () => ({
        recallMetrics: buildRecallMetrics(),
        libraryHealth: buildLibraryHealth(),
      }),
    };
    const memGenerator = createMemoryGeneratorAdapter(provider);

    /** @type {string} */
    let isoStub;
    const mockGitPublisher = {
      async publishOnIsolatedWorktree(opts) {
        isoStub = join(root, '..', 'mem-e2e-f188-iso');
        rmSync(isoStub, { recursive: true, force: true });
        mkdirSync(join(isoStub, 'docs', 'harness-feedback', 'eval-domains'), { recursive: true });
        writeFileSync(
          join(isoStub, 'docs', 'harness-feedback', 'eval-domains', 'eval-memory.yaml'),
          readFileSync(join(root, 'eval-domains', 'eval-memory.yaml'), 'utf8'),
        );
        await opts.stage(isoStub);
        return { commitSha: 'mem-f188-sha', prUrl: 'https://github.com/zts212653/clowder-ai/pull/9102' };
      },
    };

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, gitPublisher: mockGitPublisher, generator: memGenerator },
      {
        // packet targets F188 (library health finding) — domain default is F200 but
        // resolveHandoffFeatureId in adapter properly routes F188/* findings to F188.
        packet: buildMemoryPacket({
          id: 'vhp-mem-f188-cross-feature',
          verdict: 'fix',
          harnessUnderEval: { featureId: 'F188', componentId: 'orphan-edge-repair', name: 'orphan-edge-repair' },
          ownerAsk: { targetFeatureId: 'F188', targetOwnerCatId: 'opus-47', requestedAction: 'repair orphans' },
          phenomenon: 'orphan edges spiked above threshold',
        }),
        domain: 'eval:memory',
        catId: 'opus-47',
        sourceRefs: { kind: 'memory-recall-snapshot', windowDays: 30 },
      },
    );

    // RED expectation: handler MUST NOT throw `submitted_packet_evidence_mismatch`.
    // Cloud Codex R9 P1: pre-fix, my generator guard forced packet.featureId === F200
    // and rejected F188 — broke the adapter's existing cross-feature handoff contract.
    assert.ok(!('error' in result), `expected success, got: ${JSON.stringify(result)}`);
    assert.equal(result.commitSha, 'mem-f188-sha');

    // Verify snapshot + attribution reflect packet's actual F188 feature, not F200 default
    const isoBundle = join(isoStub, 'docs', 'harness-feedback', 'bundles', 'vhp-mem-f188-cross-feature');
    const snapshot = JSON.parse(readFileSync(join(isoBundle, 'snapshot.json'), 'utf8'));
    const attribution = JSON.parse(readFileSync(join(isoBundle, 'attribution.json'), 'utf8'));
    assert.equal(
      snapshot.featureId,
      'F188',
      'snapshot.featureId must follow packet.harnessUnderEval.featureId for cross-feature handoff',
    );
    assert.equal(attribution.featureId, 'F188', 'attribution.featureId must follow packet.harnessUnderEval.featureId');

    rmSync(isoStub, { recursive: true, force: true });
  });

  // Cloud Codex R10 P2: bundle schema enforces /^F\d{3}$/ (exactly 3 digits). guard
  // must align with bundle invariant so malformed F-ids (F20 / F2000) fail with
  // deterministic 400, not 500 generator_failed after writing bundle.
  it('returns 400 invalid_packet_field when packet.featureId is not exactly 3 digits (F2000)', async () => {
    const provider = {
      resolve: async () => ({
        recallMetrics: buildRecallMetrics(),
        libraryHealth: buildLibraryHealth(),
      }),
    };
    const memGenerator = createMemoryGeneratorAdapter(provider);
    const mockGitPublisher = {
      async publishOnIsolatedWorktree(opts) {
        const isoStub = join(root, '..', 'mem-e2e-invalid-fid-iso');
        rmSync(isoStub, { recursive: true, force: true });
        mkdirSync(join(isoStub, 'docs', 'harness-feedback', 'eval-domains'), { recursive: true });
        writeFileSync(
          join(isoStub, 'docs', 'harness-feedback', 'eval-domains', 'eval-memory.yaml'),
          readFileSync(join(root, 'eval-domains', 'eval-memory.yaml'), 'utf8'),
        );
        await opts.stage(isoStub);
        rmSync(isoStub, { recursive: true, force: true });
        return { commitSha: 'unreachable', prUrl: 'unreachable' };
      },
    };

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, gitPublisher: mockGitPublisher, generator: memGenerator },
      {
        packet: buildMemoryPacket({
          id: 'vhp-mem-invalid-fid',
          harnessUnderEval: { featureId: 'F2000', componentId: 'memory-recall', name: 'memory-recall' },
        }),
        domain: 'eval:memory',
        catId: 'opus-47',
        sourceRefs: { kind: 'memory-recall-snapshot', windowDays: 30 },
      },
    );

    assert.ok('error' in result);
    assert.equal(result.status, 400, 'malformed F-id must be 400 not 500');
    assert.match(result.detail, /F2000|F\\d\{3\}|3 digits/);
  });

  it('returns 400 sourceRefs_kind_mismatch when eval:memory gets a2a refs', async () => {
    const provider = {
      resolve: async () => ({
        recallMetrics: buildRecallMetrics(),
        libraryHealth: buildLibraryHealth(),
      }),
    };
    const memGenerator = createMemoryGeneratorAdapter(provider);

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, generator: memGenerator },
      {
        packet: buildMemoryPacket({ id: 'vhp-mem-kindmismatch' }),
        domain: 'eval:memory',
        catId: 'opus-47',
        // Wrong shape — a2a refs sent for memory domain
        sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
      },
    );

    assert.ok('error' in result);
    assert.equal(result.status, 400);
    assert.equal(result.error, 'sourceRefs_kind_mismatch');
    assert.match(result.detail, /eval:memory/);
    assert.match(result.detail, /memory-recall-snapshot/);
  });

  it('returns 400 sourceRefs_kind_mismatch when eval:memory gets capability-wakeup refs', async () => {
    const provider = {
      resolve: async () => ({
        recallMetrics: buildRecallMetrics(),
        libraryHealth: buildLibraryHealth(),
      }),
    };
    const memGenerator = createMemoryGeneratorAdapter(provider);

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, generator: memGenerator },
      {
        packet: buildMemoryPacket({ id: 'vhp-mem-kindmismatch-cw' }),
        domain: 'eval:memory',
        catId: 'opus-47',
        sourceRefs: {
          kind: 'capability-wakeup-trial-window',
          capability: 'rich-messaging',
          windowStartMs: 0,
          windowEndMs: 9999999999999,
          sessionIds: ['s1'],
        },
      },
    );

    assert.ok('error' in result);
    assert.equal(result.status, 400);
    assert.equal(result.error, 'sourceRefs_kind_mismatch');
  });

  it('returns 400 sourceRefs_kind_mismatch when memory-recall-snapshot used for eval:a2a', async () => {
    const provider = {
      resolve: async () => ({
        recallMetrics: buildRecallMetrics(),
        libraryHealth: buildLibraryHealth(),
      }),
    };
    const memGenerator = createMemoryGeneratorAdapter(provider);

    // memory kind on wrong domain — handler must reject before reaching adapter
    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, generator: memGenerator },
      {
        packet: buildPacket({ id: 'vhp-mem-wrong-domain', domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        sourceRefs: { kind: 'memory-recall-snapshot', windowDays: 30 },
      },
    );

    assert.ok('error' in result);
    assert.equal(result.status, 400);
    assert.equal(result.error, 'sourceRefs_kind_mismatch');
  });

  it('returns 404 no_metrics_in_window when provider yields zero events', async () => {
    const emptyProvider = {
      resolve: async () => ({
        recallMetrics: buildRecallMetrics({ totalEvents: 0 }),
        libraryHealth: buildLibraryHealth(),
      }),
    };
    const memGenerator = createMemoryGeneratorAdapter(emptyProvider);

    /** @type {string} */
    let isoStub;
    const mockGitPublisher = {
      async publishOnIsolatedWorktree(opts) {
        isoStub = join(root, '..', 'mem-e2e-empty-iso');
        mkdirSync(join(isoStub, 'docs', 'harness-feedback', 'eval-domains'), { recursive: true });
        writeFileSync(
          join(isoStub, 'docs', 'harness-feedback', 'eval-domains', 'eval-memory.yaml'),
          readFileSync(join(root, 'eval-domains', 'eval-memory.yaml'), 'utf8'),
        );
        await opts.stage(isoStub);
        return { commitSha: 'unreachable', prUrl: 'unreachable' };
      },
    };

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, gitPublisher: mockGitPublisher, generator: memGenerator },
      {
        packet: buildMemoryPacket({ id: 'vhp-mem-empty' }),
        domain: 'eval:memory',
        catId: 'opus-47',
        sourceRefs: { kind: 'memory-recall-snapshot', windowDays: 30 },
      },
    );

    assert.ok('error' in result);
    assert.equal(result.status, 404);
    assert.equal(result.error, 'no_metrics_in_window');
    assert.match(result.detail, /eval:memory|recall|no_metrics_in_window/);

    rmSync(isoStub, { recursive: true, force: true });
  });

  it('returns 501 when no memory generator wired (route-layer SoT)', async () => {
    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root /* generator omitted */ },
      {
        packet: buildMemoryPacket({ id: 'vhp-mem-no-gen' }),
        domain: 'eval:memory',
        catId: 'opus-47',
        sourceRefs: { kind: 'memory-recall-snapshot', windowDays: 30 },
      },
    );

    assert.ok('error' in result);
    assert.equal(result.status, 501);
    assert.equal(result.error, 'unsupported_generator');
    assert.match(result.detail, /eval:memory/);
  });

  it('adapter rejects sourceRefs with non-memory kind (defense-in-depth)', async () => {
    const provider = {
      resolve: async () => ({
        recallMetrics: buildRecallMetrics(),
        libraryHealth: buildLibraryHealth(),
      }),
    };
    const memGenerator = createMemoryGeneratorAdapter(provider);

    // Call adapter directly with wrong-kind refs — should throw a clear error.
    // (Handler normally guards this, but adapter must self-protect for non-handler callers.)
    await assert.rejects(async () => {
      await memGenerator(
        buildMemoryPacket({ id: 'vhp-mem-adapter-wrong' }),
        { kind: 'a2a-snapshot-attribution', snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
        { harnessFeedbackRoot: '/tmp/nonexistent', liveHarnessFeedbackRoot: '/tmp/nonexistent' },
      );
    }, /memory_adapter_wrong_kind|wrong.*kind/i);
  });
});
