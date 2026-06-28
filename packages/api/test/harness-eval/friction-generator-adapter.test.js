import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createFrictionGeneratorAdapter } from '../../dist/infrastructure/harness-eval/publish-verdict/friction-generator-adapter.js';

/**
 * F245 Phase C PR1b — friction generator adapter tests (L3).
 *
 * Mirrors capability-wakeup-generator-adapter.test.js:
 *   - Discriminator: rejects non-friction-rollup-snapshot sourceRefs (wrong kind)
 *   - Validation: rejects invalid selector (delegates to validateFrictionRollupSelector)
 *   - Provider: calls provider.resolve(selector) for the rollup input; passes selector unchanged
 *   - Registry: loads EvalDomainRegistryEntry from isolated harness root; unknown domain throws
 *   - Happy path: returns verdictPath + bundleDir (bundle-only, no extraStagedPaths — Decision 2)
 */

// setupHarnessFeedback fixture seeds 5 domains WITHOUT friction → inline-seed eval-friction.yaml.
function seedFrictionDomain(harnessFeedbackRoot) {
  const domainsDir = join(harnessFeedbackRoot, 'eval-domains');
  mkdirSync(domainsDir, { recursive: true });
  writeFileSync(
    join(domainsDir, 'eval-friction.yaml'),
    `domainId: eval:friction
displayName: Friction Signal Eval
systemThreadId: thread_eval_friction
evalCat:
  catId: gpt52
  handle: '@gpt52'
  model: gpt-5.4
frequency: weekly
sourceAdapter: f245-friction-rollup
sourceRefsKind: friction-rollup-snapshot
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent:
    - longitudinal-analysis
    - verdict-discussion
    - handoff-drafts
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: F245
  ownerCatId: opus-47
  threadLookup: feature-thread
sla:
  acknowledgeHours: 48
  reevalWithinHours: 168
fixtures: []
enabled: true
`,
  );
}

function buildSubmittedPacket(overrides = {}) {
  return {
    id: 'vhp-friction-adapter-test',
    domainId: 'eval:friction',
    createdAt: '2026-06-20T00:00:00.000Z',
    phenomenon: 'friction adapter test phenomenon',
    harnessUnderEval: { featureId: 'F245', componentId: 'friction-rollup', name: 'friction rollup' },
    evidencePacket: {
      snapshotRefs: ['placeholder:will-be-overridden'],
      attributionRefs: ['placeholder:will-be-overridden'],
      metricRefs: ['metric:friction.cluster_count'],
      sampleTraceRefs: ['trace:friction-001'],
    },
    dailyTrend: { window: '168h', current: { a: 1 }, baseline: { a: 1 }, threshold: { a: 5 }, direction: 'flat' },
    rootCauseHypothesis: { summary: 'tool_gap', confidence: 'medium', alternatives: ['alt'] },
    verdict: 'keep_observe',
    ownerAsk: { targetFeatureId: 'F245', targetOwnerCatId: 'opus-47', requestedAction: 'observe' },
    acceptanceReevalPlan: { nextEvalAt: '2026-06-27T00:00:00.000Z', closureCondition: 'stable for a week' },
    counterarguments: ['alternative interpretation'],
    ...overrides,
  };
}

function buildRollupInput({ clusters = 1 } = {}) {
  const signals = [];
  const clusterList = [];
  for (let i = 0; i < clusters; i++) {
    const signalId = `paw-feel:m${i}#0`;
    signals.push({
      id: signalId,
      channel: 'paw-feel',
      timestamp: '2026-06-19T00:00:00.000Z',
      tool: `tool-${i}`,
      symptom: `symptom ${i}`,
      rawRef: `m${i}#0`,
      severity: 'high',
    });
    clusterList.push({
      clusterId: `clu${i}`,
      representative: `symptom ${i}`,
      channels: ['paw-feel'],
      count: 1,
      members: [{ signalId, rawRef: `m${i}#0`, channel: 'paw-feel' }],
      method: 'rule',
    });
  }
  return {
    window: { sinceMs: 1_780_000_000_000, untilMs: 1_780_600_000_000 },
    signals,
    clusters: clusterList,
    degraded: false,
    droppedChannels: [],
  };
}

const SELECTOR = {
  kind: 'friction-rollup-snapshot',
  windowStartMs: 1_780_000_000_000,
  windowEndMs: 1_780_600_000_000,
};

describe('createFrictionGeneratorAdapter', () => {
  it('rejects sourceRefs with wrong kind (a2a)', async () => {
    const provider = { resolve: async () => buildRollupInput() };
    const adapter = createFrictionGeneratorAdapter(provider);
    await assert.rejects(
      adapter(
        buildSubmittedPacket(),
        { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
        { harnessFeedbackRoot: '/tmp/iso', liveHarnessFeedbackRoot: '/tmp/live' },
      ),
      /friction_adapter_wrong_kind/,
    );
  });

  it('rejects sourceRefs with missing kind', async () => {
    const provider = { resolve: async () => buildRollupInput() };
    const adapter = createFrictionGeneratorAdapter(provider);
    await assert.rejects(
      adapter(buildSubmittedPacket(), {}, { harnessFeedbackRoot: '/tmp/iso', liveHarnessFeedbackRoot: '/tmp/live' }),
      /friction_adapter_wrong_kind/,
    );
  });

  it('delegates selector validation (rejects windowEndMs <= windowStartMs)', async () => {
    const provider = { resolve: async () => buildRollupInput() };
    const adapter = createFrictionGeneratorAdapter(provider);
    await assert.rejects(
      adapter(
        buildSubmittedPacket(),
        { kind: 'friction-rollup-snapshot', windowStartMs: 100, windowEndMs: 100 },
        { harnessFeedbackRoot: '/tmp/iso', liveHarnessFeedbackRoot: '/tmp/live' },
      ),
      /invalid_source_ref.*windowEndMs/,
    );
  });

  it('throws unknown_domain when packet.domainId not in registry', async () => {
    const harnessFeedbackRoot = mkdtempSync(join(tmpdir(), 'friction-adapter-unknown-')); // empty domains dir
    const provider = { resolve: async () => buildRollupInput() };
    const adapter = createFrictionGeneratorAdapter(provider);
    await assert.rejects(
      adapter(buildSubmittedPacket(), SELECTOR, {
        harnessFeedbackRoot,
        liveHarnessFeedbackRoot: '/tmp/live',
      }),
      /unknown_domain.*eval:friction/,
    );
  });

  it('happy path: passes selector to provider unchanged and returns bundle-only artifact paths', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'friction-adapter-happy-repo-'));
    const harnessFeedbackRoot = join(repoRoot, 'docs', 'harness-feedback');
    seedFrictionDomain(harnessFeedbackRoot);

    let resolveCalledWith = null;
    const provider = {
      resolve: async (selector) => {
        resolveCalledWith = selector;
        return buildRollupInput({ clusters: 2 });
      },
    };
    const adapter = createFrictionGeneratorAdapter(provider);

    const packet = buildSubmittedPacket();
    const result = await adapter(packet, SELECTOR, {
      harnessFeedbackRoot,
      liveHarnessFeedbackRoot: '/tmp/live-unused-for-friction',
    });

    assert.deepEqual(resolveCalledWith, SELECTOR, 'adapter passes selector to provider unchanged');
    assert.match(result.verdictPath, /verdicts\/vhp-friction-adapter-test\.md$/);
    assert.match(result.bundleDir, /bundles\/vhp-friction-adapter-test$/);
    // Decision 2: friction writes raw under bundleDir/raw — NO extraStagedPaths.
    assert.ok(
      result.extraStagedPaths === undefined || result.extraStagedPaths.length === 0,
      'friction generator is bundle-only (no extraStagedPaths)',
    );

    // bundle snapshot exists + carries F245
    const snapshot = JSON.parse(readFileSync(join(result.bundleDir, 'snapshot.json'), 'utf8'));
    assert.equal(snapshot.featureId, 'F245');
  });
});
