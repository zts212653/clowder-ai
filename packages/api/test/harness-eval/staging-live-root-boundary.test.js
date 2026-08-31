import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * F257 regression — staging/live-root boundary for generator adapters.
 *
 * Bug: createLocalArtifactPublisher passes an empty staging tree as
 * deps.harnessFeedbackRoot. Generator adapters that call
 * loadDomains(deps.harnessFeedbackRoot) get an empty Map and throw
 * `unknown_domain` for every domain-aware verdict publication.
 *
 * Fix: adapters MUST call loadDomains(deps.liveHarnessFeedbackRoot) to read
 * the runtime domain registry, and use deps.harnessFeedbackRoot only as the
 * artifact output location.
 *
 * Covered adapters: anchor-telemetry, freshness, friction, task-outcome.
 * (memory, capability-wakeup, a2a were already correct.)
 *
 * TDD: written RED before the adapter loadDomains calls are fixed.
 */

// ── domain YAML seed ────────────────────────────────────────────────

function seedDomain(harnessFeedbackRoot, { domainId, displayName, sourceRefsKind }) {
  const domainsDir = join(harnessFeedbackRoot, 'eval-domains');
  mkdirSync(domainsDir, { recursive: true });
  const slug = domainId.replace(':', '-');
  writeFileSync(
    join(domainsDir, `${slug}.yaml`),
    `domainId: ${domainId}
displayName: ${displayName}
systemThreadId: thread_test
evalCat:
  catId: test-cat
  handle: '@test'
  model: test
frequency: weekly
sourceAdapter: test-adapter
sourceRefsKind: ${sourceRefsKind}
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent:
    - verdict-discussion
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: FTEST
  ownerCatId: test-cat
  threadLookup: feature-thread
sla:
  acknowledgeHours: 48
  reevalWithinHours: 168
enabled: true
`,
  );
}

function buildPacket(domainId) {
  return {
    id: `vhp-boundary-test-${domainId.replace(':', '-')}`,
    domainId,
    createdAt: '2026-08-23T00:00:00.000Z',
    phenomenon: 'staging/live-root boundary regression test',
    harnessUnderEval: { featureId: 'F257', componentId: 'boundary-test', name: 'boundary' },
    evidencePacket: {
      snapshotRefs: ['placeholder'],
      attributionRefs: ['placeholder'],
      metricRefs: ['metric:test'],
      sampleTraceRefs: ['trace:test'],
    },
    dailyTrend: { window: '168h', current: { a: 1 }, baseline: { a: 1 }, threshold: { a: 5 }, direction: 'flat' },
    rootCauseHypothesis: { summary: 'test', confidence: 'medium', alternatives: ['alt'] },
    verdict: 'keep_observe',
    ownerAsk: { targetFeatureId: 'F257', targetOwnerCatId: 'test-cat', requestedAction: 'fix' },
    acceptanceReevalPlan: { nextEvalAt: '2026-08-30T00:00:00.000Z', closureCondition: 'fixed' },
    counterarguments: ['none'],
  };
}

/**
 * Creates two temp roots: `liveRoot` has domain YAML, `stagingRoot` is empty.
 * The adapter MUST read domains from liveRoot (deps.liveHarnessFeedbackRoot),
 * not from stagingRoot (deps.harnessFeedbackRoot).
 */
function makeBoundaryDeps(domainId, displayName, sourceRefsKind) {
  const liveRepo = mkdtempSync(join(tmpdir(), 'boundary-live-'));
  const liveRoot = join(liveRepo, 'docs', 'harness-feedback');
  seedDomain(liveRoot, { domainId, displayName, sourceRefsKind });

  const stagingRepo = mkdtempSync(join(tmpdir(), 'boundary-staging-'));
  const stagingRoot = join(stagingRepo, 'docs', 'harness-feedback');
  mkdirSync(stagingRoot, { recursive: true });
  // stagingRoot is empty — no eval-domains/ directory

  return {
    harnessFeedbackRoot: stagingRoot,
    liveHarnessFeedbackRoot: liveRoot,
  };
}

// ── anchor-telemetry ────────────────────────────────────────────────

describe('anchor-telemetry adapter: staging/live-root boundary', () => {
  it('reads domain registry from liveHarnessFeedbackRoot, not empty staging root', async () => {
    const { createAnchorTelemetryGeneratorAdapter } = await import(
      '../../dist/infrastructure/harness-eval/publish-verdict/anchor-telemetry-generator-adapter.js'
    );

    const provider = {
      resolve: async () => ({
        window: { sinceMs: 1_786_698_665_681, untilMs: 1_787_303_465_681 },
        totalAnchors: 1,
        totalDrills: 0,
        anchorHitRate: 1.0,
        tokenSavings: { estimate: 500, confidence: 'medium' },
        topAnchors: [],
      }),
    };
    const adapter = createAnchorTelemetryGeneratorAdapter(provider);

    const deps = makeBoundaryDeps('eval:anchor-first', 'Anchor-First Eval', 'anchor-telemetry-snapshot');
    const sourceRefs = {
      kind: 'anchor-telemetry-snapshot',
      windowStartMs: 1_786_698_665_681,
      windowEndMs: 1_787_303_465_681,
    };

    // Before fix: loadDomains(deps.harnessFeedbackRoot) reads empty staging → unknown_domain
    // After fix: loadDomains(deps.liveHarnessFeedbackRoot) reads live → finds domain
    //
    // If the adapter passes domain lookup, it may fail at generateAnchorFirstLiveVerdict
    // (which is expected — we only test the boundary, not the full pipeline).
    // The key assertion: the error is NOT unknown_domain.
    try {
      await adapter(buildPacket('eval:anchor-first'), sourceRefs, deps);
      // If it succeeds entirely, that's fine too (domain was found)
    } catch (err) {
      assert.doesNotMatch(
        err.message,
        /unknown_domain/,
        'adapter must read domain registry from liveHarnessFeedbackRoot, not staging root',
      );
    }
  });
});

// ── freshness ───────────────────────────────────────────────────────

describe('freshness adapter: staging/live-root boundary', () => {
  it('reads domain registry from liveHarnessFeedbackRoot, not empty staging root', async () => {
    const { createFreshnessGeneratorAdapter } = await import(
      '../../dist/infrastructure/harness-eval/publish-verdict/freshness-generator-adapter.js'
    );

    const provider = {
      resolve: async () => ({
        closures: [],
        replayWindow: { startMs: 1_786_698_665_681, endMs: 1_787_303_465_681 },
        summary: { total: 0, stale: 0, fresh: 0 },
      }),
    };
    const adapter = createFreshnessGeneratorAdapter(provider);

    const deps = makeBoundaryDeps('eval:freshness', 'Freshness Eval', 'freshness-closure-replay');
    const sourceRefs = {
      kind: 'freshness-closure-replay',
      windowStartMs: 1_786_698_665_681,
      windowEndMs: 1_787_303_465_681,
    };

    try {
      await adapter(buildPacket('eval:freshness'), sourceRefs, deps);
    } catch (err) {
      assert.doesNotMatch(
        err.message,
        /unknown_domain/,
        'adapter must read domain registry from liveHarnessFeedbackRoot, not staging root',
      );
    }
  });
});

// ── friction ────────────────────────────────────────────────────────

describe('friction adapter: staging/live-root boundary', () => {
  it('reads domain registry from liveHarnessFeedbackRoot, not empty staging root', async () => {
    const { createFrictionGeneratorAdapter } = await import(
      '../../dist/infrastructure/harness-eval/publish-verdict/friction-generator-adapter.js'
    );

    const signals = [
      {
        id: 'paw-feel:m0#0',
        channel: 'paw-feel',
        timestamp: '2026-08-23T00:00:00.000Z',
        tool: 'tool-0',
        symptom: 'symptom 0',
        rawRef: 'm0#0',
        severity: 'high',
      },
    ];
    const provider = {
      resolve: async () => ({
        capturedAt: '2026-08-23T00:00:00.000Z',
        expectedCancelIds: [],
        channelCaptures: {
          'paw-feel': { status: 'ok', emittedIds: ['paw-feel:m0#0'] },
          cancel: { status: 'ok', emittedIds: [] },
          'user-feedback': { status: 'ok', emittedIds: [] },
          'eval-domain': { status: 'ok', emittedIds: [] },
        },
        rollupInput: {
          window: { sinceMs: 1_780_000_000_000, untilMs: 1_780_600_000_000 },
          signals,
          clusters: [
            {
              clusterId: 'clu0',
              representative: 'symptom 0',
              channels: ['paw-feel'],
              count: 1,
              members: [{ signalId: 'paw-feel:m0#0', rawRef: 'm0#0', channel: 'paw-feel' }],
              method: 'rule',
            },
          ],
          degraded: false,
          droppedChannels: [],
        },
        rollupReport: {
          capturedAt: '2026-08-23T00:00:00.000Z',
          featureId: 'F257',
          windowLabel: '7d',
          totalSignals: 1,
          clusteredSignals: 1,
          droppedSignals: 0,
          clusterCount: 1,
          avgClusterSize: 1,
          topClusters: [],
          channelBreakdown: [],
          baselineKind: 'prospective_paired_capture',
        },
      }),
    };
    const adapter = createFrictionGeneratorAdapter(provider);

    const deps = makeBoundaryDeps('eval:friction', 'Friction Eval', 'friction-rollup-snapshot');
    const sourceRefs = {
      kind: 'friction-rollup-snapshot',
      windowStartMs: 1_780_000_000_000,
      windowEndMs: 1_780_600_000_000,
    };

    try {
      await adapter(buildPacket('eval:friction'), sourceRefs, deps);
    } catch (err) {
      assert.doesNotMatch(
        err.message,
        /unknown_domain/,
        'adapter must read domain registry from liveHarnessFeedbackRoot, not staging root',
      );
    }
  });
});

// ── task-outcome ────────────────────────────────────────────────────

describe('task-outcome adapter: staging/live-root boundary', () => {
  it('reads domain registry from liveHarnessFeedbackRoot, not empty staging root', async () => {
    const { createTaskOutcomeGeneratorAdapter } = await import(
      '../../dist/infrastructure/harness-eval/publish-verdict/task-outcome-generator-adapter.js'
    );

    const adapter = createTaskOutcomeGeneratorAdapter();
    const deps = makeBoundaryDeps('eval:task-outcome', 'Task Outcome Eval', 'task-outcome-snapshot');
    const sourceRefs = {
      kind: 'task-outcome-snapshot',
      windowStartMs: 1_786_698_665_681,
      windowEndMs: 1_787_303_465_681,
    };

    try {
      await adapter(buildPacket('eval:task-outcome'), sourceRefs, deps);
    } catch (err) {
      assert.doesNotMatch(
        err.message,
        /unknown_domain/,
        'adapter must read domain registry from liveHarnessFeedbackRoot, not staging root',
      );
    }
  });
});
