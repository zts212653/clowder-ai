import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * F257 regression — staging/live-root boundary for generator adapters.
 *
 * `createLocalArtifactPublisher` hands each generator an EMPTY staging tree as
 * `deps.harnessFeedbackRoot`; that tree has no `eval-domains/` at all. An
 * adapter that calls `loadDomains(deps.harnessFeedbackRoot)` therefore gets an
 * empty Map and throws `unknown_domain` for every publication it is registered
 * for. The registry lives in `deps.liveHarnessFeedbackRoot`; the staging root is
 * an artifact OUTPUT location only.
 *
 * Two layers, because neither alone is sufficient:
 *
 * 1. Census (all 9 domain-aware adapters, source-level). The earlier revision of
 *    this file covered four adapters and asserted in its own header that memory,
 *    capability-wakeup and a2a "were already correct" — they were not, and the
 *    same review found design-gate and trajectory-inspector still wrong. A
 *    per-adapter list that a human maintains drifts; the census derives the list
 *    from the tree and fails when a new adapter picks the wrong root.
 *
 * 2. Behaviour, both directions, for the adapters whose fixtures are cheap. A
 *    one-directional "did not throw unknown_domain" test also passes for an
 *    adapter that reads BOTH roots, or neither. Seeding the domain into the
 *    staging root ALONE and demanding `unknown_domain` is what actually pins the
 *    read to the live root. (a2a needs real snapshot/attribution files on disk
 *    before it reaches the lookup, and memory/capability-wakeup carry their own
 *    adapter suites, so those three are census-covered here.)
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

// ── Layer 1: source census over every domain-aware generator adapter ──

const ADAPTER_DIRS = [
  'packages/api/src/infrastructure/harness-eval/publish-verdict',
  'packages/api/src/infrastructure/harness-eval/trajectory-inspector',
];

/** Frozen so a newly added adapter must be acknowledged here, not silently skipped. */
const EXPECTED_DOMAIN_AWARE_ADAPTERS = [
  'a2a-generator-adapter.ts',
  'anchor-telemetry-generator-adapter.ts',
  'capability-wakeup-generator-adapter.ts',
  'design-gate-generator-adapter.ts',
  'freshness-generator-adapter.ts',
  'friction-generator-adapter.ts',
  'memory-generator-adapter.ts',
  'task-outcome-generator-adapter.ts',
  'trajectory-inspector-generator-adapter.ts',
];

describe('generator adapter census: the eval-domain registry is read from the live root', () => {
  it('every domain-aware adapter resolves domains from liveHarnessFeedbackRoot', () => {
    const found = [];
    for (const dir of ADAPTER_DIRS) {
      for (const name of readdirSync(join(repoRoot, dir))) {
        if (!name.endsWith('-generator-adapter.ts')) continue;
        const source = readFileSync(join(repoRoot, dir, name), 'utf8');
        if (!source.includes('loadDomains(deps.')) continue;
        found.push(name);
        assert.equal(
          source.includes('loadDomains(deps.harnessFeedbackRoot)'),
          false,
          `${name} reads the eval-domain registry from the staging root; the staging tree has no eval-domains/`,
        );
        assert.ok(
          source.includes('loadDomains(deps.liveHarnessFeedbackRoot)'),
          `${name} must resolve eval domains from liveHarnessFeedbackRoot`,
        );
      }
    }
    assert.deepEqual(
      found.sort(),
      EXPECTED_DOMAIN_AWARE_ADAPTERS,
      'domain-aware adapter set changed — add the new adapter to this census and give it a boundary test',
    );
  });
});

// ── Layer 2 fixtures ────────────────────────────────────────────────

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
 * Build the two roots with the domain YAML present in exactly one of them.
 *
 * `seedIn: 'live'` is the production shape. `seedIn: 'staging'` is the inverted
 * probe: the ONLY way an adapter can find the domain there is by reading the
 * wrong root, so the lookup must fail.
 */
function makeBoundaryDeps(domain, seedIn) {
  const liveRoot = join(mkdtempSync(join(tmpdir(), 'boundary-live-')), 'docs', 'harness-feedback');
  const stagingRoot = join(mkdtempSync(join(tmpdir(), 'boundary-staging-')), 'docs', 'harness-feedback');
  mkdirSync(liveRoot, { recursive: true });
  mkdirSync(stagingRoot, { recursive: true });
  seedDomain(seedIn === 'live' ? liveRoot : stagingRoot, domain);
  // Owner-gated adapters refuse before resolving any evidence, so the boundary under
  // test is only reachable with an owner present. This is a precondition of the test,
  // not part of its contract.
  return { harnessFeedbackRoot: stagingRoot, liveHarnessFeedbackRoot: liveRoot, ownerUserId: 'boundary-owner' };
}

const WINDOW = { startMs: 1_786_698_665_681, endMs: 1_787_303_465_681 };

const frictionCapture = {
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
    signals: [
      {
        id: 'paw-feel:m0#0',
        channel: 'paw-feel',
        timestamp: '2026-08-23T00:00:00.000Z',
        tool: 'tool-0',
        symptom: 'symptom 0',
        rawRef: 'm0#0',
        severity: 'high',
      },
    ],
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
};

const ADAPTERS = [
  {
    label: 'anchor-telemetry',
    modulePath: '../../dist/infrastructure/harness-eval/publish-verdict/anchor-telemetry-generator-adapter.js',
    factoryName: 'createAnchorTelemetryGeneratorAdapter',
    provider: {
      resolve: async () => ({
        window: { sinceMs: WINDOW.startMs, untilMs: WINDOW.endMs },
        totalAnchors: 1,
        totalDrills: 0,
        anchorHitRate: 1.0,
        tokenSavings: { estimate: 500, confidence: 'medium' },
        topAnchors: [],
      }),
    },
    domain: {
      domainId: 'eval:anchor-first',
      displayName: 'Anchor-First Eval',
      sourceRefsKind: 'anchor-telemetry-snapshot',
    },
    sourceRefs: { kind: 'anchor-telemetry-snapshot', windowStartMs: WINDOW.startMs, windowEndMs: WINDOW.endMs },
  },
  {
    label: 'freshness',
    modulePath: '../../dist/infrastructure/harness-eval/publish-verdict/freshness-generator-adapter.js',
    factoryName: 'createFreshnessGeneratorAdapter',
    provider: {
      resolve: async () => ({
        closures: [],
        replayWindow: { startMs: WINDOW.startMs, endMs: WINDOW.endMs },
        summary: { total: 0, stale: 0, fresh: 0 },
        // Same reason as ownerUserId above: a blocked maturity gate would short-circuit
        // before the registry lookup this suite exists to pin.
        measurementMaturity: { status: 'ready', reasons: [] },
      }),
    },
    domain: { domainId: 'eval:freshness', displayName: 'Freshness Eval', sourceRefsKind: 'freshness-closure-replay' },
    sourceRefs: { kind: 'freshness-closure-replay', windowStartMs: WINDOW.startMs, windowEndMs: WINDOW.endMs },
  },
  {
    label: 'friction',
    modulePath: '../../dist/infrastructure/harness-eval/publish-verdict/friction-generator-adapter.js',
    factoryName: 'createFrictionGeneratorAdapter',
    provider: { resolve: async () => frictionCapture },
    domain: { domainId: 'eval:friction', displayName: 'Friction Eval', sourceRefsKind: 'friction-rollup-snapshot' },
    sourceRefs: {
      kind: 'friction-rollup-snapshot',
      windowStartMs: 1_780_000_000_000,
      windowEndMs: 1_780_600_000_000,
    },
  },
  {
    label: 'task-outcome',
    modulePath: '../../dist/infrastructure/harness-eval/publish-verdict/task-outcome-generator-adapter.js',
    factoryName: 'createTaskOutcomeGeneratorAdapter',
    provider: null,
    domain: {
      domainId: 'eval:task-outcome',
      displayName: 'Task Outcome Eval',
      sourceRefsKind: 'task-outcome-snapshot',
    },
    sourceRefs: { kind: 'task-outcome-snapshot', windowStartMs: WINDOW.startMs, windowEndMs: WINDOW.endMs },
  },
  {
    label: 'design-gate',
    modulePath: '../../dist/infrastructure/harness-eval/publish-verdict/design-gate-generator-adapter.js',
    factoryName: 'createDesignGateGeneratorAdapter',
    provider: { resolve: async () => ({}) },
    domain: {
      domainId: 'eval:design-gate',
      displayName: 'Design Gate Eval',
      sourceRefsKind: 'design-gate-episode-source-map',
    },
    sourceRefs: { kind: 'design-gate-episode-source-map', sourceMapId: 'boundary-probe' },
  },
  {
    label: 'trajectory-inspector',
    modulePath: '../../dist/infrastructure/harness-eval/trajectory-inspector/trajectory-inspector-generator-adapter.js',
    factoryName: 'createTrajectoryInspectorGeneratorAdapter',
    provider: { resolve: async () => ({}) },
    domain: {
      domainId: 'eval:trajectory-inspector',
      displayName: 'Trajectory Inspector Eval',
      sourceRefsKind: 'trajectory-inspector-window',
    },
    sourceRefs: { kind: 'trajectory-inspector-window', windowStartMs: WINDOW.startMs, windowEndMs: WINDOW.endMs },
    extraDeps: { ownerUserId: 'default-user' },
  },
];

async function runAdapter(entry, seedIn) {
  const mod = await import(entry.modulePath);
  const adapter = entry.provider ? mod[entry.factoryName](entry.provider) : mod[entry.factoryName]();
  const deps = { ...makeBoundaryDeps(entry.domain, seedIn), ...(entry.extraDeps ?? {}) };
  try {
    await adapter(buildPacket(entry.domain.domainId), entry.sourceRefs, deps);
    return null;
  } catch (err) {
    return err;
  }
}

// ── Layer 2: behaviour, both directions ─────────────────────────────

for (const entry of ADAPTERS) {
  describe(`${entry.label} adapter: staging/live-root boundary`, () => {
    it('finds the domain when the registry is in the live root', async () => {
      const err = await runAdapter(entry, 'live');
      // Reaching past the lookup is the contract under test; a later generator
      // failure on placeholder evidence is expected and irrelevant here.
      if (err) {
        assert.doesNotMatch(
          err.message,
          /unknown_domain/,
          'adapter must resolve the eval-domain registry from liveHarnessFeedbackRoot',
        );
        // A precondition that fires BEFORE the lookup would satisfy the assertion above
        // without ever exercising it. Fail loudly instead of passing vacuously.
        assert.doesNotMatch(
          err.message,
          /owner_user_required|measurement_validity_gate/,
          'a precondition short-circuited the adapter, so the root boundary was never reached',
        );
      }
    });

    it('does not fall back to the staging root when only the staging root has the registry', async () => {
      const err = await runAdapter(entry, 'staging');
      assert.ok(err, 'a domain reachable only from the staging root must not resolve');
      assert.match(
        err.message,
        /unknown_domain/,
        'reading the staging root would find this domain — the lookup must be pinned to the live root',
      );
    });
  });
}
