import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createCapabilityWakeupGeneratorAdapter } from '../../dist/infrastructure/harness-eval/publish-verdict/capability-wakeup-generator-adapter.js';
import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';

/**
 * F192 Phase H 收尾 PR-2 — end-to-end test: handler dispatches to capability-wakeup
 * generator adapter via deps.generator (route layer responsibility — eval-hub.ts:311
 * selects from opts.verdictGenerators[domainId]).
 *
 * Validates:
 *   - Handler accepts capability-wakeup domain (no longer 501 by hardcoded check)
 *   - Handler passes raw sourceRefs (cw selector) to generator
 *   - Generator dispatched correctly via deps.generator (single generator per call)
 *   - 501 still returned when domain has NO generator (e.g. eval:memory)
 *   - cw verdict path returned in repo-relative form
 */

const repoRoot = mkdtempSync(join(tmpdir(), 'publish-verdict-cw-e2e-'));
const root = join(repoRoot, 'docs', 'harness-feedback');

function seedRegistryAndDirs() {
  // Seed eval-domains registry
  const domainsDir = join(root, 'eval-domains');
  mkdirSync(domainsDir, { recursive: true });
  writeFileSync(
    join(domainsDir, 'eval-capability-wakeup.yaml'),
    `domainId: eval:capability-wakeup
displayName: Capability Wakeup Eval
systemThreadId: thread_eval_capability_wakeup
evalCat:
  catId: opus-47
  handle: "@opus47"
  model: claude-opus-4-7
frequency: weekly
sourceAdapter: capability-wakeup-eval
sourceRefsKind: capability-wakeup-trial-window
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent: [longitudinal-analysis, verdict-discussion, handoff-drafts]
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: F203
  ownerCatId: opus-47
  threadLookup: feature-thread
sla:
  acknowledgeHours: 48
  reevalWithinHours: 168
`,
  );
  // cloud R8 P2 regression test needs eval:a2a in registry too (kind-mismatch
  // check fires AFTER domain registry lookup so wrong-domain → wrong-error).
  writeFileSync(
    join(domainsDir, 'eval-a2a.yaml'),
    `domainId: eval:a2a
displayName: A2A Eval
systemThreadId: thread_eval_a2a
evalCat:
  catId: codex
  handle: "@codex"
  model: gpt-5.5
frequency: daily
sourceAdapter: f167-runtime-eval
sourceRefsKind: a2a-snapshot-attribution
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent: [longitudinal-analysis, verdict-discussion, handoff-drafts]
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: F167
  ownerCatId: codex
  threadLookup: feature-thread
sla:
  acknowledgeHours: 24
  reevalWithinHours: 72
`,
  );
  // Seed empty bundles/verdicts dirs so live-tree dup check doesn't false-positive
  mkdirSync(join(root, 'verdicts'), { recursive: true });
  mkdirSync(join(root, 'bundles'), { recursive: true });
  mkdirSync(join(root, 'registry'), { recursive: true });
  writeFileSync(
    join(root, 'registry', 'measurement-bundles.yaml'),
    `kind: f267-measurement-bundle-census
schemaVersion: 2
generatedAt: '2026-08-17T00:00:00.000Z'
sources:
  registryDir: docs/harness-feedback/eval-domains
  instructionMap: packages/api/src/infrastructure/harness-eval/eval-cat-invocation.ts#DOMAIN_INSTRUCTIONS
  publishMap: packages/api/src/infrastructure/harness-eval/eval-cat-invocation.ts#PUBLISH_VERDICT_INSTRUCTIONS_BY_DOMAIN
  verdictDir: docs/harness-feedback/verdicts
verdictCorpusHash: '${'0'.repeat(64)}'
committedVerdictArtifactCount: 0
entries:
  - domainId: eval:capability-wakeup
    classification: active_decision_bearing
    enabled: true
    decisionConsumer:
      featureId: F203
      ownerCatId: opus-47
      allowedActions: [keep_observe, fix, build, delete_sunset]
    sourceSelector:
      adapter: capability-wakeup-eval
      kind: capability-wakeup-trial-window
    committedVerdictArtifactCount: 0
    functionalEquivalents: [capability-wakeup-test]
    evidence:
      domainInstructions: true
      publishInstructions: true
    validityMigration:
      riskRank: 1
      batch: null
      status: unmigrated
      certificateRef: null
      resultRef: null
      replayRef: null
      actionGate: keep_observe_only
      hardBlockReason: test domain has no certified usable evidence
`,
  );
}

function cleanupIsoStub(name) {
  const stub = join(root, '..', name);
  if (existsSync(stub)) {
    rmSync(stub, { recursive: true, force: true });
  }
}

before(() => {
  seedRegistryAndDirs();
  // Legacy tests reuse fixed iso-stub paths; stale generator outputs from prior
  // runs would trigger the duplicate-id guard. Clean before + after.
  cleanupIsoStub('cw-e2e-iso-stub');
  cleanupIsoStub('cw-e2e-nofound-iso');
});

after(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  cleanupIsoStub('cw-e2e-iso-stub');
  cleanupIsoStub('cw-e2e-nofound-iso');
});

function buildCwPacket(overrides = {}) {
  return {
    id: 'vhp-cw-e2e-test',
    domainId: 'eval:capability-wakeup',
    createdAt: '2026-06-06T05:00:00.000Z',
    phenomenon: 'cw e2e test phenomenon',
    harnessUnderEval: { featureId: 'F203', componentId: 'rich-messaging', name: 'rich-messaging' },
    evidencePacket: {
      snapshotRefs: ['placeholder:will-be-overridden'],
      attributionRefs: ['placeholder:will-be-overridden'],
      metricRefs: ['metric:cat.signal'],
      sampleTraceRefs: ['trace:cat-001'],
    },
    dailyTrend: { window: '7d', current: { a: 1 }, baseline: { a: 1 }, threshold: { a: 5 }, direction: 'flat' },
    rootCauseHypothesis: { summary: 'cw e2e', confidence: 'medium', alternatives: ['alt'] },
    verdict: 'keep_observe',
    ownerAsk: { targetFeatureId: 'F203', targetOwnerCatId: 'opus-47', requestedAction: 'observe' },
    acceptanceReevalPlan: { nextEvalAt: '2026-06-13T05:00:00.000Z', closureCondition: 'stable for 1 week' },
    counterarguments: ['alternative interpretation'],
    ...overrides,
  };
}

function buildClassifiedTrial() {
  return {
    ruleId: 'rich-messaging-long-structured-text',
    capability: 'rich-messaging',
    sessionId: 'session-1',
    threadId: 'thread-1',
    catId: 'gpt52',
    window: { currentInvocationId: 'inv-1', nextInvocationId: 'inv-2', invocationIndex: 0 },
    eventNoSpan: { start: 0, end: 1 },
    timeSpan: { startMs: 1780000000000, endMs: 1780000000001 },
    outcome: 'miss',
    zeroFrictionDefault: true,
    opportunityEvidence: ['token_count=120', 'structured_signals=7'],
    usageEvidence: [],
    label: 'cognitive',
  };
}

const CW_DOMAIN_YAML = `domainId: eval:capability-wakeup
displayName: Capability Wakeup Eval
systemThreadId: thread_eval_capability_wakeup
evalCat:
  catId: opus-47
  handle: "@opus47"
  model: claude-opus-4-7
frequency: weekly
sourceAdapter: capability-wakeup-eval
sourceRefsKind: capability-wakeup-trial-window
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent: [longitudinal-analysis, verdict-discussion, handoff-drafts]
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: F203
  ownerCatId: opus-47
  threadLookup: feature-thread
sla:
  acknowledgeHours: 48
  reevalWithinHours: 168
`;

/**
 * F257 / F192 sunset: ArtifactPublisher mock that seeds the eval-capability-wakeup
 * registry into the output root so the cw adapter can loadDomains().
 */
function buildCwArtifactPublisher(isoPath, { artifactId, artifactUrl } = {}) {
  return {
    async publishArtifact({ packet, generate }) {
      rmSync(isoPath, { recursive: true, force: true });
      const outputRoot = join(isoPath, 'docs', 'harness-feedback');
      mkdirSync(join(outputRoot, 'eval-domains'), { recursive: true });
      writeFileSync(join(outputRoot, 'eval-domains', 'eval-capability-wakeup.yaml'), CW_DOMAIN_YAML);
      const generated = await generate(outputRoot);
      return {
        artifactId: artifactId ?? packet.id,
        domainSlug: packet.domainId.replace(/:/g, '-'),
        verdictPath: generated.verdictPath,
        bundleDir: generated.bundleDir,
        artifactUrl: artifactUrl ?? `artifact://${packet.domainId}/${packet.id}`,
      };
    },
  };
}

describe('handlePublishVerdict end-to-end with capability-wakeup generator', () => {
  it('happy path: handler dispatches to cw adapter and returns durable artifact refs', async () => {
    const provider = { resolve: async () => [buildClassifiedTrial()] };
    const cwGenerator = createCapabilityWakeupGeneratorAdapter(provider);
    const isoStub = join(root, '..', 'cw-e2e-iso-stub');
    const artifactPublisher = buildCwArtifactPublisher(isoStub, {
      artifactId: 'cw-sha-1234',
      artifactUrl: 'artifact://eval-capability-wakeup/cw-artifact-1234',
    });

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, artifactPublisher, generator: cwGenerator },
      {
        packet: buildCwPacket(),
        domain: 'eval:capability-wakeup',
        catId: 'opus-47',
        sourceRefs: {
          kind: 'capability-wakeup-trial-window',
          capability: 'rich-messaging',
          windowStartMs: 0,
          windowEndMs: 9999999999999,
          sessionIds: ['session-1'],
        },
        ownerUserId: 'default-user',
      },
    );

    assert.ok(!('error' in result), `expected success, got: ${JSON.stringify(result)}`);
    assert.equal(result.artifactId, 'cw-sha-1234');
    assert.equal(result.artifactUrl, 'artifact://eval-capability-wakeup/cw-artifact-1234');
    // F257 / F192 sunset: ArtifactPublisher returns absolute store paths; assert suffix.
    assert.match(result.verdictPath, /verdicts\/vhp-cw-e2e-test\.md$/);
    assert.match(result.bundleDir, /bundles\/vhp-cw-e2e-test$/);

    // cleanup
    rmSync(isoStub, { recursive: true, force: true });
  });

  // PR-2 R9 P1: handler-level strict validation tests (R5 + R8) extracted to
  // `publish-verdict-capability-wakeup-strict-validation.test.js` (AGENTS.md 350-line limit).

  // cloud R5 P2 (PR-2): provider throws session_not_found / cw adapter throws
  // no_trials_in_window for user-correctable input errors. Handler must map to 4xx
  // (404), not 500 generator_failed.
  it('returns 404 session_not_found when provider can not resolve sessionId', async () => {
    const provider = {
      resolve: async () => {
        throw new Error('session_not_found: stale-session-id');
      },
    };
    const cwGenerator = createCapabilityWakeupGeneratorAdapter(provider);
    const noFoundIso = join(root, '..', 'cw-e2e-nofound-iso');
    const artifactPublisher = buildCwArtifactPublisher(noFoundIso);

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, artifactPublisher, generator: cwGenerator },
      {
        packet: buildCwPacket({ id: 'vhp-cw-nofound' }),
        domain: 'eval:capability-wakeup',
        catId: 'opus-47',
        sourceRefs: {
          kind: 'capability-wakeup-trial-window',
          capability: 'rich-messaging',
          windowStartMs: 0,
          windowEndMs: 9999999999999,
          sessionIds: ['stale-session-id'],
        },
        ownerUserId: 'default-user',
      },
    );
    assert.ok('error' in result);
    assert.equal(result.status, 404);
    assert.equal(result.error, 'session_not_found');
    assert.match(result.detail, /stale-session-id/);

    rmSync(join(root, '..', 'cw-e2e-nofound-iso'), { recursive: true, force: true });
  });

  // PR #3495: zero-trial keep_observe now succeeds with no-data confidence
  // (replaces old 404 no_trials_in_window assertion — adapter-level test covers
  // the actionable-verdict throw path; E2E validates full handler → generator flow)
  it('zero-trial keep_observe succeeds with no-data confidence (PR #3495)', async () => {
    const emptyProvider = { resolve: async () => [] };
    const cwGenerator = createCapabilityWakeupGeneratorAdapter(emptyProvider);
    const artifactPublisher = buildCwArtifactPublisher(join(root, '..', 'cw-e2e-empty2-iso'), {
      artifactId: 'cw-zero-trial-artifact',
      artifactUrl: 'artifact://eval-capability-wakeup/cw-zero-trial-artifact',
    });

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, artifactPublisher, generator: cwGenerator },
      {
        packet: buildCwPacket({ id: 'vhp-cw-empty2' }),
        domain: 'eval:capability-wakeup',
        catId: 'opus-47',
        sourceRefs: {
          kind: 'capability-wakeup-trial-window',
          capability: 'rich-messaging',
          windowStartMs: 0,
          windowEndMs: 9999999999999,
          sessionIds: ['session-1'],
        },
        ownerUserId: 'default-user',
      },
    );

    assert.ok(!('error' in result), `expected success, got: ${JSON.stringify(result)}`);
    assert.equal(result.artifactId, 'cw-zero-trial-artifact');
    assert.equal(result.artifactUrl, 'artifact://eval-capability-wakeup/cw-zero-trial-artifact');
    assert.match(result.verdictPath, /verdicts\/vhp-cw-empty2\.md$/);
    assert.match(result.bundleDir, /bundles\/vhp-cw-empty2$/);

    rmSync(join(root, '..', 'cw-e2e-empty2-iso'), { recursive: true, force: true });
  });

  it('returns 501 when no generator wired for capability-wakeup domain', async () => {
    // Use eval:capability-wakeup (registered in this test's seed) but omit deps.generator.
    // Pre-validation (cw selector) passes; catId 'opus-47' passes allowlist; then no
    // generator → 501. This proves the route-layer dispatch contract: handler depends
    // on deps.generator presence, not on domain hardcoding.
    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root /* generator omitted */ },
      {
        packet: buildCwPacket({ id: 'vhp-cw-no-gen' }),
        domain: 'eval:capability-wakeup',
        catId: 'opus-47',
        sourceRefs: {
          kind: 'capability-wakeup-trial-window',
          capability: 'rich-messaging',
          windowStartMs: 0,
          windowEndMs: 9999999999999,
          sessionIds: ['session-1'],
        },
        ownerUserId: 'default-user',
      },
    );
    assert.ok('error' in result);
    assert.equal(result.status, 501);
    assert.equal(result.error, 'unsupported_generator');
    assert.match(result.detail, /eval:capability-wakeup/);
  });

  // PR #3495: actionable verdicts (fix/build/delete_sunset) are still blocked by
  // measurement_validity_gate when domain is keep_observe_only. This validates the
  // gate → 409 path at E2E level (adapter-level zero-trial throw tested separately).
  it('returns 409 measurement_validity_gate when actionable verdict blocked by keep_observe_only gate', async () => {
    const emptyProvider = { resolve: async () => [] };
    const cwGenerator = createCapabilityWakeupGeneratorAdapter(emptyProvider);
    const artifactPublisher = buildCwArtifactPublisher(join(root, '..', 'cw-e2e-empty-iso'));

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, artifactPublisher, generator: cwGenerator },
      {
        packet: buildCwPacket({ id: 'vhp-cw-empty', verdict: 'fix' }),
        domain: 'eval:capability-wakeup',
        catId: 'opus-47',
        sourceRefs: {
          kind: 'capability-wakeup-trial-window',
          capability: 'rich-messaging',
          windowStartMs: 0,
          windowEndMs: 9999999999999,
          sessionIds: ['session-1'],
        },
        ownerUserId: 'default-user',
      },
    );
    assert.ok('error' in result);
    assert.equal(result.status, 409);
    assert.equal(result.error, 'measurement_validity_gate');
    assert.match(result.detail, /keep_observe_only/);

    rmSync(join(root, '..', 'cw-e2e-empty-iso'), { recursive: true, force: true });
  });
});
