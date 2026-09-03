// @ts-check

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);
const repoRoot = resolve(import.meta.dirname, '../../../..');

async function moduleUnderTest() {
  return import('../../dist/infrastructure/harness-eval/measurement/measurement-decision-proof.js');
}

async function schemaModuleUnderTest() {
  return import('../../dist/infrastructure/harness-eval/measurement/measurement-decision-proof-schema.js');
}

async function publicModuleUnderTest() {
  return import('../../dist/infrastructure/harness-eval/index.js');
}

async function readYaml(ref) {
  return parse(await readFile(resolve(repoRoot, ref), 'utf8'));
}

async function validInputs() {
  const certificate = await readYaml('docs/harness-feedback/certificates/f267-memory-search-quality.yaml');
  const result = await readYaml(
    'docs/harness-feedback/measurement-results/f267-memory-search-quality-negative-control-v1.yaml',
  );
  const proof = {
    kind: 'f267-measurement-decision-proof-candidate',
    schemaVersion: 1,
    proofId: 'f267-memory-search-quality-decision-proof-v1',
    generatedAt: '2026-08-31T17:00:00.000Z',
    subject: {
      certificateId: certificate.certificateId,
      certificateRef: result.certificateRef,
      certificateSha256: SHA_A,
      resultId: result.resultId,
      resultRef: 'docs/harness-feedback/measurement-results/f267-memory-search-quality-negative-control-v1.yaml',
      resultSha256: SHA_B,
      evaluationCohortRef: result.cohort.ref,
      evaluationCohortSha256: result.cohort.sha256,
    },
    evidenceRole: {
      cohortRef: result.cohort.ref,
      cohortSha256: result.cohort.sha256,
      roles: ['validation'],
      proof: {
        ownerFeatureId: 'F267',
        ref: 'docs/harness-feedback/decision-proofs/memory-evidence-role.yaml',
        sha256: SHA_C,
      },
    },
    consumerConsumption: {
      consumerFeatureId: certificate.decision.consumerFeatureId,
      consumerOwnerCatId: certificate.decision.consumerOwnerCatId,
      resultId: result.resultId,
      consumedAt: '2026-08-31T17:05:00.000Z',
      receipt: {
        ownerFeatureId: certificate.decision.consumerFeatureId,
        ref: 'docs/harness-feedback/decision-proofs/memory-consumption-receipt.yaml',
        sha256: SHA_D,
      },
    },
    optimizerExposure: {
      cohortRef: result.cohort.ref,
      cohortSha256: result.cohort.sha256,
      candidateSelection: 'exposed',
      rubricSelection: 'not_exposed',
      proof: {
        ownerFeatureId: 'F267',
        ref: 'docs/harness-feedback/decision-proofs/memory-optimizer-exposure.yaml',
        sha256: SHA_C,
      },
    },
    promotionHoldout: {
      cohortRef: 'docs/harness-feedback/decision-proofs/memory-promotion-holdout.yaml',
      cohortSha256: SHA_D,
      window: { startMs: 300, endMs: 400 },
      independence: {
        kind: 'time_fresh',
        optimizerSelectionCutoffMs: 250,
      },
      optimizerExposure: {
        candidateSelection: 'not_exposed',
        rubricSelection: 'not_exposed',
      },
      proof: {
        ownerFeatureId: 'F267',
        ref: 'docs/harness-feedback/decision-proofs/memory-promotion-holdout-proof.yaml',
        sha256: SHA_C,
      },
    },
  };
  return { certificate, result, proof };
}

describe('F267 measurement decision proof', () => {
  it('keeps candidate assessment non-authoritative until owner objects are resolved', async () => {
    const { assessMeasurementDecisionProofCandidate } = await moduleUnderTest();
    const { certificate, result, proof } = await validInputs();

    const assessed = assessMeasurementDecisionProofCandidate(certificate, result, proof);

    assert.equal(assessed.kind, 'f267-measurement-decision-proof-candidate-assessment');
    assert.equal(assessed.status, 'candidate_sufficient');
    assert.notEqual(assessed.status, 'verified');
    assert.equal(assessed.subject.measurementDecisionStatus, 'insufficient');
    assert.equal(assessed.consumerConsumption.resultId, result.resultId);
    assert.equal(assessed.promotionHoldout.independence.kind, 'time_fresh');
  });

  it('keeps authoritative producers and parsers out of public and direct candidate modules', async () => {
    const publicModule = await publicModuleUnderTest();
    const candidateModule = await moduleUnderTest();
    const schemaModule = await schemaModuleUnderTest();

    assert.equal(typeof publicModule.createFileMeasurementDecisionProofResolver, 'function');
    assert.equal('assessMeasurementDecisionProof' in publicModule, false);
    assert.equal('assessMeasurementDecisionProofCandidate' in publicModule, false);
    assert.equal('MeasurementDecisionProofSchema' in publicModule, false);
    assert.equal('MeasurementDecisionProofCandidateSchema' in publicModule, false);
    assert.equal('assessMeasurementDecisionProof' in candidateModule, false);
    assert.equal('MeasurementDecisionProofSchema' in candidateModule, false);
    assert.equal('MeasurementDecisionProofSchema' in schemaModule, false);
  });

  it('returns typed insufficient instead of manufacturing any missing proof', async () => {
    const { assessMeasurementDecisionProofCandidate } = await moduleUnderTest();
    const { certificate, result, proof } = await validInputs();
    const fields = [
      ['evidenceRole', 'evidence_role'],
      ['consumerConsumption', 'consumer_consumption'],
      ['optimizerExposure', 'optimizer_exposure'],
      ['promotionHoldout', 'promotion_holdout'],
    ];

    for (const [field, expectedMissing] of fields) {
      const incomplete = structuredClone(proof);
      delete incomplete[field];

      const assessed = assessMeasurementDecisionProofCandidate(certificate, result, incomplete);

      assert.equal(assessed.status, 'candidate_insufficient');
      assert.deepEqual(assessed.missingProofs, [expectedMissing]);
      assert.deepEqual(assessed.blockers, []);
    }
  });

  it('rejects an insufficient projection whose withdrawal conditions do not match its deficiencies', async () => {
    const { assessMeasurementDecisionProofCandidate, MeasurementDecisionProofCandidateAssessmentSchema } =
      await moduleUnderTest();
    const { certificate, result, proof } = await validInputs();
    delete proof.evidenceRole;
    const assessed = assessMeasurementDecisionProofCandidate(certificate, result, proof);
    assessed.withdrawalConditions = ['attach_optimizer_exposure_proof'];

    assert.throws(
      () => MeasurementDecisionProofCandidateAssessmentSchema.parse(assessed),
      /withdrawal conditions must exactly match/i,
    );
  });

  it('returns typed insufficient when a claimed promotion holdout was optimizer-exposed', async () => {
    const { assessMeasurementDecisionProofCandidate } = await moduleUnderTest();
    const { certificate, result, proof } = await validInputs();
    proof.promotionHoldout.optimizerExposure.candidateSelection = 'exposed';

    const assessed = assessMeasurementDecisionProofCandidate(certificate, result, proof);

    assert.equal(assessed.status, 'candidate_insufficient');
    assert.deepEqual(assessed.missingProofs, []);
    assert.deepEqual(assessed.blockers, ['promotion_holdout_optimizer_exposed']);
  });

  it('returns typed insufficient unless time-fresh evidence starts strictly after optimizer selection closes', async () => {
    const { assessMeasurementDecisionProofCandidate } = await moduleUnderTest();
    const { certificate, result, proof } = await validInputs();
    proof.promotionHoldout.independence.optimizerSelectionCutoffMs = 350;

    const assessed = assessMeasurementDecisionProofCandidate(certificate, result, proof);

    assert.equal(assessed.status, 'candidate_insufficient');
    assert.deepEqual(assessed.blockers, ['promotion_holdout_not_time_fresh']);

    proof.promotionHoldout.independence.optimizerSelectionCutoffMs = proof.promotionHoldout.window.startMs;
    const equalBoundary = assessMeasurementDecisionProofCandidate(certificate, result, proof);
    assert.equal(equalBoundary.status, 'candidate_insufficient');
    assert.deepEqual(equalBoundary.blockers, ['promotion_holdout_not_time_fresh']);
  });

  it('accepts a sealed holdout only when it was sealed before optimizer selection', async () => {
    const { assessMeasurementDecisionProofCandidate } = await moduleUnderTest();
    const { certificate, result, proof } = await validInputs();
    proof.promotionHoldout.independence = {
      kind: 'sealed',
      sealedAtMs: 200,
      optimizerSelectionCutoffMs: 250,
      seal: {
        ownerFeatureId: 'F267',
        ref: 'docs/harness-feedback/decision-proofs/memory-promotion-holdout-seal.yaml',
        sha256: SHA_A,
      },
    };

    assert.equal(assessMeasurementDecisionProofCandidate(certificate, result, proof).status, 'candidate_sufficient');

    proof.promotionHoldout.independence.sealedAtMs = 275;
    const assessed = assessMeasurementDecisionProofCandidate(certificate, result, proof);
    assert.equal(assessed.status, 'candidate_insufficient');
    assert.deepEqual(assessed.blockers, ['promotion_holdout_not_sealed']);

    proof.promotionHoldout.independence.sealedAtMs = proof.promotionHoldout.independence.optimizerSelectionCutoffMs;
    const equalBoundary = assessMeasurementDecisionProofCandidate(certificate, result, proof);
    assert.equal(equalBoundary.status, 'candidate_insufficient');
    assert.deepEqual(equalBoundary.blockers, ['promotion_holdout_not_sealed']);
  });

  it('rejects proof bound to another result, cohort, or consumer identity', async () => {
    const { assessMeasurementDecisionProofCandidate } = await moduleUnderTest();
    const { certificate, result, proof } = await validInputs();

    const wrongResult = structuredClone(proof);
    wrongResult.subject.resultId = 'some-other-result';
    assert.throws(
      () => assessMeasurementDecisionProofCandidate(certificate, result, wrongResult),
      /proof subject does not match/i,
    );

    const wrongCohort = structuredClone(proof);
    wrongCohort.optimizerExposure.cohortSha256 = SHA_A;
    assert.throws(
      () => assessMeasurementDecisionProofCandidate(certificate, result, wrongCohort),
      /optimizer exposure does not match/i,
    );

    const wrongRole = structuredClone(proof);
    wrongRole.evidenceRole.cohortSha256 = SHA_A;
    assert.throws(
      () => assessMeasurementDecisionProofCandidate(certificate, result, wrongRole),
      /evidence role does not match/i,
    );

    const wrongConsumer = structuredClone(proof);
    wrongConsumer.consumerConsumption.consumerFeatureId = 'F311';
    assert.throws(
      () => assessMeasurementDecisionProofCandidate(certificate, result, wrongConsumer),
      /consumer consumption does not match/i,
    );
  });

  it('does not accept the evaluation cohort itself as a promotion holdout', async () => {
    const { assessMeasurementDecisionProofCandidate } = await moduleUnderTest();
    const { certificate, result, proof } = await validInputs();
    proof.promotionHoldout.cohortRef = result.cohort.ref;
    proof.promotionHoldout.cohortSha256 = result.cohort.sha256;

    const assessed = assessMeasurementDecisionProofCandidate(certificate, result, proof);

    assert.equal(assessed.status, 'candidate_insufficient');
    assert.deepEqual(assessed.blockers, ['promotion_holdout_reuses_evaluation_cohort']);
  });
});
