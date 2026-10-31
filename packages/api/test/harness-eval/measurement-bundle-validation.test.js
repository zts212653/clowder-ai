// @ts-check

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function decisionComponents() {
  return [
    ['judge', 'friction-eval-cat', 'gpt52-v1', 'docs/harness-feedback/eval-domains/eval-friction.yaml'],
    ['rubric', 'f267-friction-rubric', 'f267-phase-b-v1', 'docs/features/F267-eval-measurement-validity.md'],
    [
      'classifier',
      'friction-clusterer',
      'f245-clusterer-v1',
      'packages/api/src/infrastructure/harness-eval/friction/friction-clusterer.ts',
    ],
    [
      'prompt',
      'eval-friction-instructions',
      'f267-phase-b-v1',
      'packages/api/src/infrastructure/harness-eval/eval-cat-invocation.ts',
    ],
    ['model', 'friction-eval-model', 'gpt-5.4', 'docs/harness-feedback/eval-domains/eval-friction.yaml'],
    [
      'code',
      'friction-measurement-result',
      'f267-phase-b-v1',
      'packages/api/src/infrastructure/harness-eval/measurement/friction-measurement-bundle.ts',
    ],
  ].map(([kind, name, version, artifactRef], index) => ({
    kind,
    name,
    version,
    artifactRef,
    artifactSha256: index % 2 === 0 ? SHA_A : SHA_B,
  }));
}

async function moduleUnderTest() {
  return import('../../dist/infrastructure/harness-eval/measurement/measurement-bundle-validation.js');
}

async function validCertificate() {
  const { computeDecisionProcedureVersionSetHash } = await moduleUnderTest();
  const components = decisionComponents();
  return {
    kind: 'f267-measurement-certificate',
    schemaVersion: 1,
    certificateId: 'f267-friction-opportunity-to-action-v1',
    bundleId: 'eval:friction/friction-opportunity-to-action',
    domainId: 'eval:friction',
    status: 'issued',
    measurementTarget: {
      id: 'friction_opportunity_to_action',
      estimand: 'cancel adapter recall over canonical opportunities in a closed window',
      utilityClaim: 'Higher verified recall means cancel signals are less likely to disappear before triage.',
      unitOfAnalysis: 'canonical friction opportunity row',
    },
    decision: {
      consumerFeatureId: 'F245',
      consumerOwnerCatId: 'opus-47',
      allowedActions: ['keep_observe', 'fix', 'build', 'delete_sunset'],
      primaryQuestion: 'Is the friction measurement evidence strong enough to support an owner action?',
    },
    targetPopulation: {
      description: 'A2 and proxy friction opportunities in the selected closed window.',
      inclusion: ['permission_cancel', 'cancel_burst'],
      exclusion: ['rows outside the half-open window'],
    },
    window: {
      boundary: 'half_open',
      selection: 'caller supplies a closed [sinceMs, untilMs) window',
      maxDurationHours: 168,
    },
    metrics: [
      {
        id: 'cancel_adapter_recall',
        role: 'primary_loss',
        description: 'Fraction of canonical cancel opportunity ids emitted by the adapter.',
        owner: 'F245 cancel adapter',
        estimator: 'intersection(expectedIds, actualIds) / expectedIds',
        goodDirection: 'higher',
      },
      {
        id: 'downstream_available',
        role: 'guardrail',
        description: 'Whether aggregation and clustering completed without degraded dependencies.',
        owner: 'F245 friction rollup',
        estimator: '1 when rollupInput.degraded=false, otherwise 0',
        goodDirection: 'higher',
      },
      {
        id: 'paw_feel_actionable_count',
        role: 'context',
        description: 'Actionable paw-feel signal count for interpretation only.',
        owner: 'F245 friction rollup',
      },
      {
        id: 'dropped_channels',
        role: 'diagnostic',
        description: 'Channels whose adapter pull failed.',
        owner: 'F245 friction provider',
      },
    ],
    errorCosts: {
      falsePositive: 'Opening a repair thread for normal or sensor-induced variation.',
      falseNegative: 'Leaving repeated user-visible friction untriaged.',
    },
    validityBounds: [
      'Cancel recall is valid only when canonical opportunity ids are frozen from the same exact window.',
      'Non-cancel channels have unmeasured opportunity and cannot support recall claims.',
    ],
    sampleContract: {
      unit: 'canonical opportunity id',
      inclusion: 'All matching canonical rows in the half-open window.',
      exclusion: 'No retrospective aggregate-only rows.',
      missingness: 'No opportunity or unavailable source remains unknown, never zero.',
    },
    uncertainty: {
      method: 'exact id reconciliation plus interval or power evidence when a rate drives action',
      requiredEvidence: {
        n: true,
        pointEstimate: true,
        intervalOrPower: true,
      },
      insufficientWhen: ['n=0', 'source unavailable', 'required guardrail degraded'],
    },
    calibrationPlan: {
      reference: 'canonical TaskOutcomeEpisodeStore rows and independent human adjudication',
      cadence: 'every pilot window and after source/judge version changes',
      failureThreshold: 'any id mismatch or adjudication disagreement above the registered tolerance',
      action: 'withdraw the result and rerun after repairing the observation surface',
    },
    withdrawalConditions: [
      'source contract or exact window identity changes',
      'required judge component version cannot be resolved',
    ],
    interventionPolicy: {
      requiredFor: ['fix', 'build', 'delete_sunset'],
    },
    decisionProcedure: {
      artifactRevision: 'd'.repeat(40),
      components,
      versionSetHash: computeDecisionProcedureVersionSetHash(components),
    },
    repeatabilityContract: {
      stage: 'acceptance',
      frozenCohortContract: 'Replay binds the exact artifact ref and SHA-256.',
      minimumRuns: 2,
      allowedVariation: 'none for the deterministic measurement sufficiency projection',
      tolerance: 'exact agreement for metric evidence and decision status',
    },
    provenance: {
      featureId: 'F267',
      sourceRevision: 'c'.repeat(40),
      generatedAt: '2026-07-19T16:00:00Z',
    },
  };
}

async function validResult() {
  const certificate = await validCertificate();
  return {
    kind: 'f267-measurement-bundle-result',
    schemaVersion: 1,
    resultId: 'f267-friction-2026-07-18',
    certificateId: certificate.certificateId,
    certificateRef: 'docs/harness-feedback/certificates/f267-friction-opportunity-to-action.yaml',
    bundleId: certificate.bundleId,
    domainId: certificate.domainId,
    generatedAt: '2026-07-19T16:10:00Z',
    cohort: {
      ref: 'docs/harness-feedback/bundles/frozen/raw/measurement-validity.json',
      sha256: SHA_A,
      window: { startMs: 100, endMs: 200 },
    },
    decisionProcedureVersionSetHash: certificate.decisionProcedure.versionSetHash,
    metrics: [
      {
        metricId: 'cancel_adapter_recall',
        role: 'primary_loss',
        n: 12,
        pointEstimate: 1,
        evidenceStatus: 'sufficient',
        uncertainty: {
          kind: 'interval',
          method: 'clopper_pearson',
          lower: 0.735,
          upper: 1,
          confidence: 0.95,
        },
      },
      {
        metricId: 'downstream_available',
        role: 'guardrail',
        n: 1,
        pointEstimate: 1,
        evidenceStatus: 'sufficient',
        uncertainty: {
          kind: 'power',
          method: 'deterministic_guardrail',
          power: 1,
          targetEffect: 'detect any degraded dependency',
        },
      },
    ],
    decision: {
      status: 'usable',
      reasons: [],
      withdrawalConditions: [],
    },
    actionProposal: {
      action: 'keep_observe',
      rationale: 'The evidence is usable but does not independently justify a repair.',
    },
  };
}

describe('F267 measurement bundle certificate and result contract', () => {
  it('accepts one full certificate and result', async () => {
    const { parseMeasurementBundleCertificate, validateMeasurementBundleResult } = await moduleUnderTest();
    const certificate = parseMeasurementBundleCertificate(await validCertificate());
    const result = validateMeasurementBundleResult(certificate, await validResult());

    assert.equal(result.decision.status, 'usable');
    assert.equal(result.metrics.length, 2);
  });

  it('keeps artifact retrieval revision outside the procedure version identity', async () => {
    const { parseMeasurementBundleCertificate } = await moduleUnderTest();
    const certificate = await validCertificate();
    const versionSetHash = certificate.decisionProcedure.versionSetHash;
    certificate.decisionProcedure.artifactRevision = 'e'.repeat(40);

    const parsed = parseMeasurementBundleCertificate(certificate);

    assert.equal(parsed.decisionProcedure.artifactRevision, 'e'.repeat(40));
    assert.equal(parsed.decisionProcedure.versionSetHash, versionSetHash);
  });

  it('rejects a non-immutable artifact revision', async () => {
    const { parseMeasurementBundleCertificate } = await moduleUnderTest();
    const certificate = await validCertificate();
    certificate.decisionProcedure.artifactRevision = 'HEAD';

    assert.throws(() => parseMeasurementBundleCertificate(certificate), /Git revision/i);
  });

  it('requires exactly one readable version for judge, rubric, classifier, prompt, model, and code', async () => {
    const { parseMeasurementBundleCertificate } = await moduleUnderTest();
    const certificate = await validCertificate();
    certificate.decisionProcedure.components = certificate.decisionProcedure.components.filter(
      (component) => component.kind !== 'prompt',
    );

    assert.throws(() => parseMeasurementBundleCertificate(certificate), /prompt/i);
  });

  it('rejects a context metric that tries to carry a decision estimator', async () => {
    const { parseMeasurementBundleCertificate } = await moduleUnderTest();
    const certificate = await validCertificate();
    certificate.metrics[2].estimator = 'actionable / emitted';

    assert.throws(() => parseMeasurementBundleCertificate(certificate));
  });

  it('rejects stale or fabricated decision-procedure version hashes', async () => {
    const { parseMeasurementBundleCertificate } = await moduleUnderTest();
    const certificate = await validCertificate();
    certificate.decisionProcedure.versionSetHash = SHA_B;

    assert.throws(() => parseMeasurementBundleCertificate(certificate), /versionSetHash/i);
  });

  it('rejects point-only or zero-n evidence labeled usable', async () => {
    const { validateMeasurementBundleResult } = await moduleUnderTest();
    const certificate = await validCertificate();
    const result = await validResult();
    result.metrics[0] = {
      ...result.metrics[0],
      n: 0,
      evidenceStatus: 'sufficient',
      uncertainty: { kind: 'not_estimable', reason: 'no opportunity' },
    };

    assert.throws(() => validateMeasurementBundleResult(certificate, result), /usable|sufficient|not_estimable/i);
  });

  it('forces the overall result to insufficient when any decision metric is insufficient', async () => {
    const { validateMeasurementBundleResult } = await moduleUnderTest();
    const certificate = await validCertificate();
    const result = await validResult();
    result.metrics[0] = {
      ...result.metrics[0],
      n: 0,
      pointEstimate: null,
      evidenceStatus: 'insufficient',
      uncertainty: { kind: 'not_estimable', reason: 'no canonical opportunity' },
    };

    assert.throws(() => validateMeasurementBundleResult(certificate, result), /overall decision.*insufficient/i);

    result.decision = {
      status: 'insufficient',
      reasons: ['cancel_join:no_opportunity'],
      withdrawalConditions: ['rerun_after_closed_window_with_cancel_opportunity'],
    };
    assert.equal(validateMeasurementBundleResult(certificate, result).decision.status, 'insufficient');
  });

  it('requires an intervention card before fix, build, or delete_sunset', async () => {
    const { validateMeasurementBundleResult } = await moduleUnderTest();
    const certificate = await validCertificate();

    for (const action of ['fix', 'build', 'delete_sunset']) {
      const result = await validResult();
      result.actionProposal = { action, rationale: 'Action proposed from measured loss.' };
      assert.throws(() => validateMeasurementBundleResult(certificate, result), /intervention card/i);
    }
  });

  it('accepts a complete intervention card and keeps guardrails explicit', async () => {
    const { validateMeasurementBundleResult } = await moduleUnderTest();
    const certificate = await validCertificate();
    const result = await validResult();
    result.actionProposal = {
      action: 'fix',
      rationale: 'The paired loss is reproducible and crosses the registered decision boundary.',
      interventionCard: {
        observedLoss: 'cancel_adapter_recall is below the registered acceptance bound',
        competingAttributions: ['adapter filtering', 'canonical opportunity corruption'],
        keyScientificQuestion: 'Does bypassing adapter filtering restore the missing canonical ids?',
        interventionLever: 'cancel adapter filtering predicate',
        causalRationale: 'Only the adapter output differs from the frozen canonical set.',
        expectedDelta: 'restore recall to 1.0 on the replay cohort',
        falsifier: 'missing ids remain after the filtering predicate is removed',
        replayCohort: result.cohort.ref,
        holdout: 'the next independent closed window with cancel opportunities',
        targetMetricIds: ['cancel_adapter_recall'],
        guardrailMetricIds: ['downstream_available'],
        reevaluationWindow: 'replay immediately, then one independent 72h closed window',
        costAndRollback: 'one adapter commit; revert the predicate change if guardrails regress',
      },
    };

    assert.equal(validateMeasurementBundleResult(certificate, result).actionProposal?.action, 'fix');
  });

  it('requires the result metric set and version identity to match its certificate', async () => {
    const { validateMeasurementBundleResult } = await moduleUnderTest();
    const certificate = await validCertificate();
    const result = await validResult();
    result.metrics.pop();
    assert.throws(() => validateMeasurementBundleResult(certificate, result), /metric set/i);

    const other = await validResult();
    other.decisionProcedureVersionSetHash = SHA_B;
    assert.throws(() => validateMeasurementBundleResult(certificate, other), /version set/i);
  });
});
