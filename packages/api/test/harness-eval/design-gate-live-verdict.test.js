import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generateDesignGateLiveVerdict } from '../../dist/infrastructure/harness-eval/design-gate/eval-design-gate-live-verdict.js';
import {
  buildLifecycleRootArtifact,
  deriveEvalCaseId,
  readLifecycleRootArtifact,
  writeLifecycleRootArtifact,
} from '../../dist/infrastructure/harness-eval/publish-verdict/lifecycle-root-artifact.js';

const domain = {
  domainId: 'eval:design-gate',
  displayName: 'Design Gate Integrity Eval',
  systemThreadId: 'thread_mt0y0eqoltcf3ryn',
  evalCat: { catId: 'codex-sol', handle: '@codex-sol', model: 'gpt-5.6-sol' },
  frequency: 'weekly',
  sourceAdapter: 'f303-design-gate-episode',
  sourceRefsKind: 'design-gate-episode-source-map',
  threadPolicy: { role: 'working-home', stateSot: 'registry', allowedContent: ['longitudinal-analysis'] },
  legacyScheduledTaskIds: [],
  handoffTargetResolver: { featureId: 'F303', ownerCatId: 'codex-sol', threadLookup: 'feature-thread' },
  sla: { acknowledgeHours: 48, reevalWithinHours: 336 },
  fixtures: [],
  enabled: true,
};

function packet(verdict = 'keep_observe') {
  return {
    id: `f303-design-gate-${verdict.replaceAll('_', '-')}`,
    domainId: 'eval:design-gate',
    findingKey: 'observation-window',
    createdAt: '2026-08-23T17:00:00.000Z',
    phenomenon: 'One complete episode is reconstructable; the utility window is not mature.',
    harnessUnderEval: { featureId: 'F303', componentId: 'design-gate-evidence', name: 'F303 Design Gate' },
    evidencePacket: {
      snapshotRefs: ['placeholder:snapshot'],
      attributionRefs: ['placeholder:attribution'],
      metricRefs: [
        'metric:eligible_episodes',
        'metric:pre_review_unique_catches',
        'metric:post_merge_divergence_escapes',
        'metric:false_positive_blocks',
        'metric:extra_active_minutes',
        'metric:extra_review_rounds',
      ],
      sampleTraceRefs: ['repo:docs/harness-feedback/design-gate/source-maps/f303-phase-c-pr3901.yaml'],
    },
    dailyTrend: {
      window: 'bootstrap',
      current: { eligible_episodes: 1 },
      baseline: { eligible_episodes: 0 },
      threshold: { eligible_episodes: 20 },
      direction: 'unknown',
    },
    rootCauseHypothesis: {
      summary: 'The observation window is too small for a utility decision.',
      confidence: 'high',
      alternatives: ['The first episode may not represent later changes.'],
    },
    verdict,
    ownerAsk: {
      targetFeatureId: 'F303',
      targetOwnerCatId: 'codex-sol',
      requestedAction: 'Keep observing until four weeks or twenty eligible episodes.',
    },
    acceptanceReevalPlan: {
      nextEvalAt: '2026-08-30T17:00:00.000Z',
      closureCondition: 'Re-evaluate from the same domain with canonical new episode refs.',
    },
    counterarguments: ['The source adapter could still miss an unrecorded false positive.'],
  };
}

function bundle(overrides = {}) {
  return {
    selector: { kind: 'design-gate-episode-source-map', sourceMapId: 'f303-phase-c-pr3901' },
    sourceMapRef: 'docs/harness-feedback/design-gate/source-maps/f303-phase-c-pr3901.yaml',
    window: { startMs: 1787501390000, endMs: 1787503920000 },
    episodes: [
      {
        episodeId: 'f303-phase-c-pr3901',
        featureId: 'F303',
        authorCatId: 'codex-sol',
        reviewerCatId: 'opus-47',
        eligibility: { eligible: true, trigger: 'preservation_boundary_delta' },
        consequence: { kind: 'alpha_no_escape', evidenceRef: 'alpha:f303-phase-c-pr3901-alpha#services' },
        sourceRefs: [
          'github:pr:zts212653/cat-cafe#3901',
          'local-review:0001787501286658-000077-5d3e5e07:g1:approved',
          'alpha:f303-phase-c-pr3901-alpha#services',
        ],
        validation: { status: 'valid', reasons: [] },
      },
    ],
    vector: {
      eligibleEpisodes: 1,
      preReviewUniqueCatches: null,
      postMergeDivergenceEscapes: 0,
      falsePositiveBlocks: null,
      extraActiveMinutes: null,
      extraReviewRounds: null,
    },
    validity: {
      status: 'insufficient',
      resultRef: null,
      reasons: ['measurement validity result is not yet linked'],
    },
    observation: {
      status: 'observing',
      mature: false,
      elapsedMs: 2530000,
      eligibleEpisodeCount: 1,
      maturityRule: 'four_weeks_or_twenty_episodes',
    },
    ...overrides,
  };
}

test('keep_observe writes a refs-only vector bundle without a composite score or model-judge fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'f303-design-gate-verdict-'));
  const artifact = generateDesignGateLiveVerdict({
    verdictId: 'f303-design-gate-keep-observe',
    harnessFeedbackRoot: root,
    domain,
    episodeBundle: bundle(),
    submittedPacket: packet(),
    generatedAt: '2026-08-23T17:00:00.000Z',
  });

  const snapshot = JSON.parse(readFileSync(join(artifact.bundleDir, 'snapshot.json'), 'utf8'));
  const raw = JSON.parse(readFileSync(join(artifact.bundleDir, 'raw', 'episode-source-refs.json'), 'utf8'));
  assert.deepEqual(snapshot.components[0].activationCounts, {
    eligible_episodes: 1,
    pre_review_unique_catches: null,
  });
  assert.deepEqual(snapshot.components[0].frictionCounts, {
    post_merge_divergence_escapes: 0,
    false_positive_blocks: null,
    extra_active_minutes: null,
    extra_review_rounds: null,
  });
  assert.equal('score' in snapshot, false);
  assert.equal(JSON.stringify(snapshot).includes('calibrationRunway'), false);
  assert.equal(JSON.stringify(snapshot).includes('modelJudge'), false);
  assert.equal(JSON.stringify(raw).includes('Local Review Verdict'), false);
  assert.equal(raw.episodes[0].sourceRefs.length, 3);
  assert.match(
    artifact.markdown,
    /description: "Live verdict for the independent F303 Design Gate utility observation domain\."/,
  );
  assert.match(artifact.markdown, /description_source: human/);
  assert.match(artifact.markdown, /description_author: codex-sol/);
  assert.match(artifact.markdown, /description_updated_at: 2026-08-23T17:00:00\.000Z/);
  assert.match(artifact.markdown, /Validity: `insufficient`/);
  assert.match(artifact.markdown, /Observation: `observing`/);

  const lifecycle = writeLifecycleRootArtifact(artifact.bundleDir, artifact.packet);
  const repeated = buildLifecycleRootArtifact({
    ...artifact.packet,
    id: 'f303-design-gate-keep-observe-next-cycle',
    createdAt: '2026-08-30T17:00:00.000Z',
  });
  assert.deepEqual(readLifecycleRootArtifact(artifact.bundleDir), lifecycle);
  assert.equal(lifecycle.schemaVersion, 2);
  assert.equal(lifecycle.domainId, 'eval:design-gate');
  assert.equal(lifecycle.ownerAsk.targetFeatureId, 'F303');
  assert.equal(lifecycle.ownerAsk.targetOwnerCatId, 'codex-sol');
  assert.equal(lifecycle.caseId, deriveEvalCaseId('eval:design-gate', 'observation-window'));
  assert.equal(repeated.caseId, lifecycle.caseId, 're-eval cycles retain one stable domain-local case identity');
});

test('each evidence gate independently rejects every actionable verdict', () => {
  const cases = [
    {
      name: 'no complete episode',
      overrides: {
        episodes: [{ ...bundle().episodes[0], validation: { status: 'invalid', reasons: ['source gap'] } }],
        validity: { status: 'usable', resultRef: 'repo:usable.yaml', reasons: [] },
        observation: { ...bundle().observation, status: 'window_mature', mature: true },
      },
    },
    {
      name: 'validity not usable',
      overrides: {
        validity: { status: 'insufficient', resultRef: null, reasons: ['not certified'] },
        observation: { ...bundle().observation, status: 'window_mature', mature: true },
      },
    },
    {
      name: 'observation immature',
      overrides: { validity: { status: 'usable', resultRef: 'repo:usable.yaml', reasons: [] } },
    },
  ];
  for (const { name, overrides } of cases) {
    for (const verdict of ['fix', 'build', 'delete_sunset']) {
      const root = mkdtempSync(join(tmpdir(), 'f303-design-gate-action-'));
      assert.throws(
        () =>
          generateDesignGateLiveVerdict({
            verdictId: `f303-design-gate-${verdict.replaceAll('_', '-')}`,
            harnessFeedbackRoot: root,
            domain,
            episodeBundle: bundle(overrides),
            submittedPacket: packet(verdict),
            generatedAt: '2026-08-23T17:00:00.000Z',
          }),
        /design_gate_action_not_allowed/,
        `${name} must reject ${verdict}`,
      );
    }
  }
});

test('missing complete episodes can publish only an explicit keep_observe source-gap finding', () => {
  const root = mkdtempSync(join(tmpdir(), 'f303-design-gate-gap-'));
  const invalidBundle = bundle({
    episodes: [
      {
        ...bundle().episodes[0],
        consequence: null,
        validation: { status: 'invalid', reasons: ['landed Alpha consequence source invalid'] },
      },
    ],
    validity: { status: 'invalid', resultRef: null, reasons: ['landed Alpha consequence source invalid'] },
  });
  const artifact = generateDesignGateLiveVerdict({
    verdictId: 'f303-design-gate-source-gap',
    harnessFeedbackRoot: root,
    domain,
    episodeBundle: invalidBundle,
    submittedPacket: { ...packet(), id: 'f303-design-gate-source-gap' },
    generatedAt: '2026-08-23T17:00:00.000Z',
  });
  const attribution = JSON.parse(readFileSync(join(artifact.bundleDir, 'attribution.json'), 'utf8'));
  assert.equal(attribution.findings.length, 1);
  assert.equal(attribution.findings[0].frictionSignal.type, 'design_gate.source_gap');
  assert.equal(artifact.packet.verdict, 'keep_observe');
});
