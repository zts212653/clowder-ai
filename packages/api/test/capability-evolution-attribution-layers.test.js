import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import {
  COHORT,
  candidate,
  loadEvaluationModules,
  rubricRef,
  validMeasurementInput,
} from './capability-evolution-attribution.helper.mjs';

describe('F311 Phase 3 four-layer attribution', () => {
  let assessMeasurementJoin;
  let assessRubricComparability;
  let resolveAttribution;

  before(async () => {
    ({ assessMeasurementJoin, assessRubricComparability, resolveAttribution } = await loadEvaluationModules());
  });

  describe('attribution records real hits only', () => {
    const comparable = () =>
      assessRubricComparability({
        frozenCohortRef: COHORT,
        previousRubricRef: rubricRef('v3'),
        currentRubricRef: rubricRef('v3'),
      });

    it('attributes a single discriminating layer and never claims coverage it does not have', () => {
      const assessment = resolveAttribution({
        programId: 'prog-evolve-video-skill',
        cycle: 1,
        measurement: assessMeasurementJoin(validMeasurementInput()),
        comparability: comparable(),
        candidates: [candidate('execution', true), candidate('harness', false)],
      });
      assert.equal(assessment.verdict, 'attributed');
      assert.equal(assessment.primaryLayer, 'execution');
      assert.deepEqual(assessment.assessedLayers, ['execution', 'harness']);
      assert.deepEqual(assessment.notAssessedLayers, ['rubric', 'observation']);
      assert.equal(assessment.disposition, 'intervention_candidate');
      assert.equal(assessment.event.type, 'attribution_linked');

      const { diagnosis } = assessment.event;
      assert.equal(diagnosis.verdict, 'attributed');
      assert.equal(diagnosis.primaryLayer, 'execution');
      assert.deepEqual(diagnosis.assessedLayers, ['execution', 'harness']);
      assert.deepEqual(diagnosis.competingLayers, ['execution']);
      assert.equal(diagnosis.uncertaintyBasis, 'interval');
      assert.equal(diagnosis.comparabilityMode, 'unchanged');
      assert.ok(diagnosis.evidenceRefs.length > 0);
      // Derived, never persisted: "nobody looked" must not harden into "ruled out".
      assert.equal(diagnosis.notAssessedLayers, undefined);
      const keys = diagnosis.evidenceRefs.map((ref) => `${ref.ownerFeatureId} ${ref.ownerStateRef}`);
      assert.equal(new Set(keys).size, keys.length);
    });

    it('carries the failure codes into the durable diagnosis snapshot', () => {
      const assessment = resolveAttribution({
        programId: 'prog-evolve-video-skill',
        cycle: 1,
        measurement: assessMeasurementJoin(validMeasurementInput({ ownerDecisionStatus: 'insufficient' })),
        comparability: comparable(),
        candidates: [candidate('execution', true)],
      });
      assert.equal(assessment.event.diagnosis.verdict, 'insufficient');
      assert.equal(assessment.event.diagnosis.primaryLayer, undefined);
      assert.ok(assessment.event.diagnosis.reasonCodes.includes('measurement_insufficient'));
      assert.ok(assessment.event.diagnosis.reasonCodes.includes('owner_declared_insufficient'));
    });

    it('supports all four layers as first-class candidates', () => {
      for (const layer of ['execution', 'harness', 'rubric', 'observation']) {
        const assessment = resolveAttribution({
          programId: 'prog-evolve-video-skill',
          cycle: 1,
          measurement: assessMeasurementJoin(validMeasurementInput()),
          comparability: comparable(),
          candidates: [candidate(layer, true)],
        });
        assert.equal(assessment.verdict, 'attributed', layer);
        assert.equal(assessment.primaryLayer, layer);
      }
    });

    it('is unresolved when several layers stay equally supported', () => {
      const assessment = resolveAttribution({
        programId: 'prog-evolve-video-skill',
        cycle: 1,
        measurement: assessMeasurementJoin(validMeasurementInput()),
        comparability: comparable(),
        candidates: [candidate('execution', true), candidate('observation', true)],
      });
      assert.equal(assessment.verdict, 'unresolved');
      assert.equal(assessment.primaryLayer, undefined);
      assert.deepEqual(assessment.competingLayers, ['execution', 'observation']);
      assert.equal(assessment.disposition, 'no_intervention');
    });

    it('is unresolved when nothing discriminates', () => {
      const assessment = resolveAttribution({
        programId: 'prog-evolve-video-skill',
        cycle: 1,
        measurement: assessMeasurementJoin(validMeasurementInput()),
        comparability: comparable(),
        candidates: [candidate('harness', false)],
      });
      assert.equal(assessment.verdict, 'unresolved');
      assert.ok(assessment.reasons.some((reason) => reason.code === 'no_discriminating_evidence'));
    });

    it('drops candidates with no owner evidence instead of counting them', () => {
      const assessment = resolveAttribution({
        programId: 'prog-evolve-video-skill',
        cycle: 1,
        measurement: assessMeasurementJoin(validMeasurementInput()),
        comparability: comparable(),
        candidates: [candidate('execution', true), { layer: 'rubric', discriminating: true, evidenceRefs: [] }],
      });
      assert.equal(assessment.verdict, 'attributed');
      assert.equal(assessment.primaryLayer, 'execution');
      assert.ok(assessment.notAssessedLayers.includes('rubric'));
      assert.ok(assessment.reasons.some((reason) => reason.code === 'attribution_candidate_without_evidence'));
    });

    it('reports insufficient before looking at candidates when measurement is insufficient', () => {
      const assessment = resolveAttribution({
        programId: 'prog-evolve-video-skill',
        cycle: 1,
        measurement: assessMeasurementJoin(validMeasurementInput({ ownerDecisionStatus: 'insufficient' })),
        comparability: comparable(),
        candidates: [candidate('execution', true)],
      });
      assert.equal(assessment.verdict, 'insufficient');
      assert.equal(assessment.primaryLayer, undefined);
      assert.equal(assessment.disposition, 'no_intervention');
    });

    it('reports incomparable and refuses to splice scores across rubric versions', () => {
      const assessment = resolveAttribution({
        programId: 'prog-evolve-video-skill',
        cycle: 1,
        measurement: assessMeasurementJoin(validMeasurementInput()),
        comparability: assessRubricComparability({
          frozenCohortRef: COHORT,
          previousRubricRef: rubricRef('v3'),
          currentRubricRef: rubricRef('v4'),
        }),
        candidates: [candidate('execution', true)],
      });
      assert.equal(assessment.verdict, 'incomparable');
      assert.equal(assessment.primaryLayer, undefined);
      assert.equal(assessment.disposition, 'no_intervention');
    });
  });
});
