import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import {
  ALL_CELLS,
  COHORT,
  candidate,
  loadEvaluationModules,
  ownerRef,
  RESULT,
  rejudgeCell,
  rubricRef,
  UNCERTAINTY,
  validMeasurementInput,
} from './capability-evolution-attribution.helper.mjs';

describe('F311 Phase 3 measurement join and rubric comparability', () => {
  let assessMeasurementJoin;
  let assessRubricComparability;

  before(async () => {
    ({ assessMeasurementJoin, assessRubricComparability } = await loadEvaluationModules());
  });

  describe('measurement join stays ref-only and fails closed', () => {
    it('accepts a complete owner-backed measurement bundle', () => {
      const assessment = assessMeasurementJoin(validMeasurementInput());
      assert.equal(assessment.validity, 'valid');
      assert.deepEqual(assessment.reasons, []);
      assert.equal(assessment.event.type, 'measurement_linked');
      assert.deepEqual(assessment.event.measurementResultRef, RESULT);
      assert.equal(assessment.event.validity, 'valid');
      // The reason and evidence are persisted so a restart can explain itself.
      assert.deepEqual(assessment.event.reasonCodes, []);
      assert.equal(assessment.event.uncertaintyBasis, 'interval');
      assert.ok(assessment.event.evidenceRefs.length > 0);
    });

    it('honours the owner insufficient verdict instead of re-deciding it', () => {
      const assessment = assessMeasurementJoin(validMeasurementInput({ ownerDecisionStatus: 'insufficient' }));
      assert.equal(assessment.validity, 'insufficient');
      assert.ok(assessment.reasons.some((reason) => reason.code === 'owner_declared_insufficient'));
      assert.equal(assessment.event.validity, 'insufficient');
    });

    it('treats a not-estimable uncertainty basis as insufficient', () => {
      const assessment = assessMeasurementJoin(
        validMeasurementInput({ uncertainty: { evidenceRef: UNCERTAINTY, basis: 'not_estimable' } }),
      );
      assert.equal(assessment.validity, 'insufficient');
      assert.ok(assessment.reasons.some((reason) => reason.code === 'uncertainty_not_estimable'));
    });

    it('rejects F311-owned evidence so the control plane cannot own measurement truth', () => {
      const assessment = assessMeasurementJoin(
        validMeasurementInput({ frozenCohortRef: ownerRef('F311', 'local-cohort:copy') }),
      );
      assert.equal(assessment.validity, 'insufficient');
      assert.ok(assessment.reasons.some((reason) => reason.code === 'f311_cannot_own_evidence'));
    });

    it('is insufficient when the frozen cohort, baseline, exposure proof or uncertainty is missing', () => {
      for (const [field, code] of [
        ['frozenCohortRef', 'frozen_cohort_missing'],
        ['baselineRef', 'baseline_missing'],
        ['exposureProofRef', 'exposure_proof_missing'],
        ['uncertainty', 'uncertainty_evidence_missing'],
      ]) {
        const assessment = assessMeasurementJoin(validMeasurementInput({ [field]: undefined }));
        assert.equal(assessment.validity, 'insufficient', field);
        assert.ok(
          assessment.reasons.some((reason) => reason.code === code),
          `${field} should raise ${code}`,
        );
      }
    });
  });

  describe('rubric version changes need a 2x2 rejudge or a rebuilt baseline', () => {
    it('is comparable when the rubric version did not move', () => {
      const assessment = assessRubricComparability({
        frozenCohortRef: COHORT,
        previousRubricRef: rubricRef('v3'),
        currentRubricRef: rubricRef('v3'),
      });
      assert.equal(assessment.comparability, 'comparable');
      assert.equal(assessment.mode, 'unchanged');
    });

    it('refuses to call a versionless rubric unchanged', () => {
      const assessment = assessRubricComparability({
        frozenCohortRef: COHORT,
        previousRubricRef: rubricRef(undefined),
        currentRubricRef: rubricRef(undefined),
      });
      assert.equal(assessment.comparability, 'incomparable');
      assert.ok(assessment.reasons.some((reason) => reason.code === 'rubric_version_missing'));
    });

    it('applies the F311 ownership guard to rubric and rejudge refs', () => {
      const ownedRubric = { ...rubricRef('v4'), ownerFeatureId: 'F311' };
      const owned = assessRubricComparability({
        frozenCohortRef: COHORT,
        previousRubricRef: rubricRef('v3'),
        currentRubricRef: ownedRubric,
        rejudge: { frozenCohortRef: COHORT, cells: ALL_CELLS },
      });
      assert.equal(owned.comparability, 'incomparable');
      assert.ok(owned.reasons.some((reason) => reason.code === 'f311_cannot_own_evidence'));

      const ownedCell = assessRubricComparability({
        frozenCohortRef: COHORT,
        previousRubricRef: rubricRef('v3'),
        currentRubricRef: rubricRef('v4'),
        rejudge: {
          frozenCohortRef: COHORT,
          cells: [
            ...ALL_CELLS.slice(0, 3),
            { rubric: 'current', candidate: 'current', resultRef: ownerRef('F311', 'local-rejudge:copy') },
          ],
        },
      });
      assert.equal(ownedCell.comparability, 'incomparable');
      assert.ok(ownedCell.reasons.some((reason) => reason.code === 'f311_cannot_own_evidence'));
    });

    it('rejects a 2x2 that fills one coordinate twice instead of covering all four', () => {
      const assessment = assessRubricComparability({
        frozenCohortRef: COHORT,
        previousRubricRef: rubricRef('v3'),
        currentRubricRef: rubricRef('v4'),
        rejudge: {
          frozenCohortRef: COHORT,
          cells: [
            ...ALL_CELLS,
            { rubric: 'previous', candidate: 'previous', resultRef: ownerRef('F267', 'rejudge-result:extra') },
          ],
        },
      });
      assert.equal(assessment.comparability, 'incomparable');
      assert.ok(assessment.reasons.some((reason) => reason.code === 'rejudge_duplicate_cell'));
    });

    it('keeps both rubric versions in the evidence trail', () => {
      const assessment = assessRubricComparability({
        frozenCohortRef: COHORT,
        previousRubricRef: rubricRef('v3'),
        currentRubricRef: rubricRef('v4'),
        rejudge: { frozenCohortRef: COHORT, cells: ALL_CELLS },
      });
      const versions = assessment.evidenceRefs.filter((ref) => ref.ownerStateRef === 'rubric:evolve-video-skill');
      assert.deepEqual(
        versions.map((ref) => ref.version),
        ['v3', 'v4'],
      );
    });

    it('is comparable after a complete 2x2 rejudge on the same frozen cohort', () => {
      const assessment = assessRubricComparability({
        frozenCohortRef: COHORT,
        previousRubricRef: rubricRef('v3'),
        currentRubricRef: rubricRef('v4'),
        rejudge: { frozenCohortRef: COHORT, cells: ALL_CELLS },
      });
      assert.equal(assessment.comparability, 'comparable');
      assert.equal(assessment.mode, 'two_by_two_rejudge');
      assert.deepEqual(assessment.missingCells, []);
    });

    it('is comparable when the owner rebuilt the baseline instead', () => {
      const assessment = assessRubricComparability({
        frozenCohortRef: COHORT,
        previousRubricRef: rubricRef('v3'),
        currentRubricRef: rubricRef('v4'),
        baselineRebuildRef: ownerRef('F267', 'measurement-baseline:evolve-video-skill:v4-rebuild'),
      });
      assert.equal(assessment.comparability, 'comparable');
      assert.equal(assessment.mode, 'baseline_rebuild');
    });

    it('is incomparable and names the missing cells when the 2x2 is partial', () => {
      const assessment = assessRubricComparability({
        frozenCohortRef: COHORT,
        previousRubricRef: rubricRef('v3'),
        currentRubricRef: rubricRef('v4'),
        rejudge: { frozenCohortRef: COHORT, cells: ALL_CELLS.slice(0, 3) },
      });
      assert.equal(assessment.comparability, 'incomparable');
      assert.equal(assessment.spliceAllowed, false);
      assert.deepEqual(assessment.missingCells, [{ rubric: 'current', candidate: 'current' }]);
      assert.ok(assessment.reasons.some((reason) => reason.code === 'rejudge_incomplete'));
    });

    it('rejects a rejudge that reuses one result for several cells', () => {
      const shared = rejudgeCell('previous', 'previous').resultRef;
      const assessment = assessRubricComparability({
        frozenCohortRef: COHORT,
        previousRubricRef: rubricRef('v3'),
        currentRubricRef: rubricRef('v4'),
        rejudge: { frozenCohortRef: COHORT, cells: ALL_CELLS.map((cell) => ({ ...cell, resultRef: shared })) },
      });
      assert.equal(assessment.comparability, 'incomparable');
      assert.ok(assessment.reasons.some((reason) => reason.code === 'rejudge_cell_reused'));
    });

    it('rejects a rejudge run on a different cohort than the frozen one', () => {
      const assessment = assessRubricComparability({
        frozenCohortRef: COHORT,
        previousRubricRef: rubricRef('v3'),
        currentRubricRef: rubricRef('v4'),
        rejudge: { frozenCohortRef: ownerRef('F267', 'frozen-cohort:other'), cells: ALL_CELLS },
      });
      assert.equal(assessment.comparability, 'incomparable');
      assert.ok(assessment.reasons.some((reason) => reason.code === 'rejudge_cohort_drift'));
    });

    it('is incomparable when the rubric moved with no rejudge and no rebuild', () => {
      const assessment = assessRubricComparability({
        frozenCohortRef: COHORT,
        previousRubricRef: rubricRef('v3'),
        currentRubricRef: rubricRef('v4'),
      });
      assert.equal(assessment.comparability, 'incomparable');
      assert.ok(assessment.reasons.some((reason) => reason.code === 'rubric_version_changed_without_rejudge'));
    });
  });
});
