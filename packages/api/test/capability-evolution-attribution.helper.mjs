/**
 * Shared fixtures for the F311 Phase 3 evaluation suites.
 *
 * Owner refs, a valid measurement join and a complete intervention card, in one place so the two
 * suites that exercise them cannot drift into disagreeing about what "valid" means.
 */

export const ownerRef = (ownerFeatureId, ownerStateRef, version) =>
  version === undefined ? { ownerFeatureId, ownerStateRef } : { ownerFeatureId, ownerStateRef, version };

export const CERTIFICATE = ownerRef('F267', 'measurement-certificate:evolve-video-skill');
export const RESULT = ownerRef('F267', 'measurement-result:evolve-video-skill:w7');
export const COHORT = ownerRef('F267', 'frozen-cohort:evolve-video-skill:w7');
export const BASELINE = ownerRef('F267', 'measurement-baseline:evolve-video-skill:w0');
export const UNCERTAINTY = ownerRef('F267', 'uncertainty-evidence:evolve-video-skill:w7');
export const EXPOSURE = ownerRef('F267', 'exposure-proof:evolve-video-skill:w7');

export const validMeasurementInput = (overrides = {}) => ({
  certificateRef: CERTIFICATE,
  measurementResultRef: RESULT,
  ownerDecisionStatus: 'usable',
  frozenCohortRef: COHORT,
  baselineRef: BASELINE,
  exposureProofRef: EXPOSURE,
  uncertainty: { evidenceRef: UNCERTAINTY, basis: 'interval' },
  ...overrides,
});

export const rubricRef = (version) => ({
  ownerFeatureId: 'F192',
  ownerStateRef: 'rubric:evolve-video-skill',
  version,
  assetKind: 'rubric',
  assetId: 'evolve-video-skill',
});

export const rejudgeCell = (rubric, candidate) => ({
  rubric,
  candidate,
  resultRef: ownerRef('F267', `rejudge-result:${rubric}-rubric:${candidate}-candidate`),
});

export const ALL_CELLS = [
  rejudgeCell('previous', 'previous'),
  rejudgeCell('previous', 'current'),
  rejudgeCell('current', 'previous'),
  rejudgeCell('current', 'current'),
];

export const candidate = (layer, discriminating, refs = 1) => ({
  layer,
  discriminating,
  evidenceRefs: Array.from({ length: refs }, (_value, index) => ownerRef('F299', `inv:${layer}-${index}`)),
});

export const completeCard = (overrides = {}) => ({
  cardRef: ownerRef('F267', 'intervention-card:evolve-video-skill:c1'),
  competingAttributionRefs: [
    ownerRef('F267', 'competing-attribution:harness'),
    ownerRef('F267', 'competing-attribution:rubric'),
  ],
  causalHypothesisRef: ownerRef('F267', 'causal-hypothesis:evolve-video-skill:c1'),
  expectedDeltaRef: ownerRef('F267', 'expected-delta:evolve-video-skill:c1'),
  guardrailRefs: [ownerRef('F267', 'guardrail-metric:latency')],
  replayCohortRef: COHORT,
  promotionHoldoutRef: ownerRef('F267', 'sealed-holdout:evolve-video-skill:h1'),
  holdoutExposureProofRef: ownerRef('F267', 'exposure-proof:sealed-holdout:h1'),
  holdoutOptimizerExposed: false,
  interventionFalsifierRef: ownerRef('F267', 'intervention-falsifier:evolve-video-skill:c1'),
  rubricReopenTriggerRef: ownerRef('F267', 'rubric-reopen-trigger:evolve-video-skill:c1'),
  costRef: ownerRef('F311', 'evolution-economics:evolve-video-skill'),
  rollbackRef: ownerRef('F202', 'rollback-plan:skill:video-forge'),
  ...overrides,
});

/** The Phase 3 units under test, loaded from dist so the suites exercise the built artifact. */
export async function loadEvaluationModules() {
  const [bridge, gate, projection, explanation] = await Promise.all([
    import('../dist/infrastructure/capability-evolution/program-eval-bridge.js'),
    import('../dist/infrastructure/capability-evolution/intervention-gate.js'),
    import('../dist/infrastructure/capability-evolution/program-attribution-projection.js'),
    import('../dist/infrastructure/capability-evolution/attribution-explanation.js'),
  ]);
  return {
    assessMeasurementJoin: bridge.assessMeasurementJoin,
    assessRubricComparability: bridge.assessRubricComparability,
    resolveAttribution: bridge.resolveAttribution,
    evaluateInterventionGate: gate.evaluateInterventionGate,
    toAttributionGateView: gate.toAttributionGateView,
    projectEvolutionAttribution: projection.projectEvolutionAttribution,
    buildAttributionExplanation: explanation.buildAttributionExplanation,
    projectAttributionExplanation: explanation.projectAttributionExplanation,
  };
}
