const SHA256 = 'a'.repeat(64);

/**
 * Build a schema-valid F267 certificate without reading the home evidence archive.
 * Public contract tests consume this fixture after the API build has produced dist/.
 */
export async function createMeasurementCertificateFixture({
  certificateId = 'f267-fixture-v1',
  bundleId = 'eval:friction/fixture',
  domainId = 'eval:friction',
  measurementTargetId = 'fixture_measurement',
} = {}) {
  const { computeDecisionProcedureVersionSetHash } = await import(
    '../../../dist/infrastructure/harness-eval/measurement/measurement-bundle-validation.js'
  );
  const components = ['judge', 'rubric', 'classifier', 'prompt', 'model', 'code'].map((kind) => ({
    kind,
    name: `fixture-${kind}`,
    version: 'fixture-v1',
    artifactRef: `test/fixtures/${kind}.txt`,
    artifactSha256: SHA256,
  }));

  return {
    kind: 'f267-measurement-certificate',
    schemaVersion: 1,
    certificateId,
    bundleId,
    domainId,
    status: 'issued',
    measurementTarget: {
      id: measurementTargetId,
      estimand: 'fixture estimand',
      utilityClaim: 'fixture utility claim',
      unitOfAnalysis: 'fixture unit',
    },
    decision: {
      consumerFeatureId: 'F268',
      consumerOwnerCatId: 'fixture-owner',
      allowedActions: ['keep_observe', 'fix', 'build', 'delete_sunset'],
      primaryQuestion: 'Is the fixture evidence sufficient?',
    },
    targetPopulation: {
      description: 'Fixture population.',
      inclusion: ['fixture rows'],
      exclusion: [],
    },
    window: {
      boundary: 'half_open',
      selection: 'fixture window',
      maxDurationHours: 1,
    },
    metrics: [
      {
        id: 'fixture_loss',
        role: 'primary_loss',
        description: 'Fixture loss metric.',
        owner: 'fixture owner',
        estimator: 'fixture estimator',
        goodDirection: 'lower',
      },
    ],
    errorCosts: {
      falsePositive: 'Fixture false-positive cost.',
      falseNegative: 'Fixture false-negative cost.',
    },
    validityBounds: ['Fixture validity bound.'],
    sampleContract: {
      unit: 'fixture row',
      inclusion: 'All fixture rows.',
      exclusion: 'No excluded fixture rows.',
      missingness: 'Missing fixture rows remain unknown.',
    },
    uncertainty: {
      method: 'fixture method',
      requiredEvidence: { n: true, pointEstimate: true, intervalOrPower: true },
      insufficientWhen: ['fixture evidence is missing'],
    },
    calibrationPlan: {
      reference: 'fixture reference',
      cadence: 'every fixture run',
      failureThreshold: 'any mismatch',
      action: 'withdraw fixture result',
    },
    withdrawalConditions: ['fixture contract changes'],
    interventionPolicy: { requiredFor: ['fix', 'build', 'delete_sunset'] },
    decisionProcedure: {
      artifactRevision: 'b'.repeat(40),
      components,
      versionSetHash: computeDecisionProcedureVersionSetHash(components),
    },
    repeatabilityContract: {
      stage: 'acceptance',
      frozenCohortContract: 'Fixture cohort is immutable.',
      minimumRuns: 2,
      allowedVariation: 'none',
      tolerance: 'exact agreement',
    },
    provenance: {
      featureId: 'F267',
      sourceRevision: 'c'.repeat(40),
      generatedAt: '2026-07-19T16:00:00Z',
    },
  };
}
