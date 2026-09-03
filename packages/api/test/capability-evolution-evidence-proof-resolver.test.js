import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { createProgramEvidenceProofResolver } from '../dist/infrastructure/capability-evolution/program-evidence-proof-resolver.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);
const evidenceProofRef = { ownerFeatureId: 'F267', ownerStateRef: 'measurement-proof:proof-1' };

function ownerRef(ownerFeatureId, ref, sha256) {
  return { ownerFeatureId, ref, sha256 };
}

function verifiedProof(overrides = {}) {
  return {
    kind: 'f267-measurement-decision-proof',
    schemaVersion: 1,
    status: 'verified',
    proofId: 'proof-1',
    generatedAt: '2026-09-01T08:00:00.000Z',
    subject: {
      certificateId: 'certificate-1',
      certificateRef: 'certificate:one',
      certificateSha256: SHA_A,
      resultId: 'result-1',
      resultRef: 'measurement-result:one',
      resultSha256: SHA_B,
      evaluationCohortRef: 'cohort:evaluation-1',
      evaluationCohortSha256: SHA_C,
      measurementDecisionStatus: 'insufficient',
    },
    evidenceRole: {
      cohortRef: 'cohort:evaluation-1',
      cohortSha256: SHA_C,
      roles: ['validation'],
      proof: ownerRef('F267', 'evidence-role:observer-1', SHA_A),
    },
    consumerConsumption: {
      consumerFeatureId: 'F311',
      consumerOwnerCatId: 'codex-sol',
      resultId: 'result-1',
      consumedAt: '2026-09-01T08:05:00.000Z',
      receipt: ownerRef('F311', 'consumption:receipt-1', SHA_B),
    },
    optimizerExposure: {
      cohortRef: 'cohort:evaluation-1',
      cohortSha256: SHA_C,
      candidateSelection: 'not_exposed',
      rubricSelection: 'not_exposed',
      proof: ownerRef('F267', 'optimizer-exposure:proof-1', SHA_C),
    },
    promotionHoldout: {
      cohortRef: 'cohort:promotion-1',
      cohortSha256: SHA_D,
      window: { startMs: 300, endMs: 400 },
      independence: { kind: 'time_fresh', optimizerSelectionCutoffMs: 250 },
      optimizerExposure: { candidateSelection: 'not_exposed', rubricSelection: 'not_exposed' },
      proof: ownerRef('F267', 'promotion-holdout:proof-1', SHA_D),
    },
    ...overrides,
  };
}

function resolverReturning(resolution) {
  return createProgramEvidenceProofResolver({
    decisionProofResolver: {
      async resolve() {
        return resolution;
      },
    },
  });
}

async function resolveWith(resolver) {
  return resolver({ ownerUserId: 'operator', evidenceProofRef, sourceBindings: [] });
}

describe('F311 canonical F267 evidence proof adapter', () => {
  it('wires the canonical file resolver through the production Program bootstrap', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

    assert.match(source, /createFileMeasurementDecisionProofResolver/);
    assert.match(source, /createProgramEvidenceProofResolver/);
    assert.match(source, /evidenceProofResolver:\s*createProgramEvidenceProofResolver/);
  });

  it('projects a verified owner decision proof into ref-only F311 evidence roles', async () => {
    const result = await resolveWith(resolverReturning({ status: 'resolved', proof: verifiedProof() }));

    assert.deepEqual(result, {
      status: 'verified',
      proofRefs: {
        decisionProofRef: evidenceProofRef,
        evidenceRoleRef: {
          ownerFeatureId: 'F267',
          ownerStateRef: 'evidence-role:observer-1',
          version: SHA_A,
        },
        consumptionProofRef: {
          ownerFeatureId: 'F311',
          ownerStateRef: 'consumption:receipt-1',
          version: SHA_B,
        },
        optimizerExposureProofRef: {
          ownerFeatureId: 'F267',
          ownerStateRef: 'optimizer-exposure:proof-1',
          version: SHA_C,
        },
        promotionHoldoutRef: {
          ownerFeatureId: 'F267',
          ownerStateRef: 'promotion-holdout:proof-1',
          version: SHA_D,
        },
      },
    });
  });

  it('maps every owner-declared missing proof to a typed F311 insufficiency', async () => {
    const proof = {
      ...verifiedProof(),
      status: 'insufficient',
      evidenceRole: undefined,
      consumerConsumption: undefined,
      optimizerExposure: undefined,
      promotionHoldout: undefined,
      missingProofs: ['evidence_role', 'consumer_consumption', 'optimizer_exposure', 'promotion_holdout'],
      blockers: [],
      withdrawalConditions: [
        'attach_owner_backed_evidence_role_proof',
        'attach_named_consumer_consumption_receipt',
        'attach_optimizer_exposure_proof',
        'attach_independent_sealed_or_time_fresh_promotion_holdout',
      ],
    };

    const result = await resolveWith(resolverReturning({ status: 'resolved', proof }));

    assert.equal(result.status, 'insufficient');
    assert.deepEqual(
      result.blockers.map(({ code }) => code),
      [
        'evidence_role_missing',
        'consumption_proof_missing',
        'optimizer_exposure_proof_missing',
        'promotion_holdout_missing',
      ],
    );
  });

  it('preserves every owner-declared independent holdout blocker', async () => {
    const blockerCodes = [
      'promotion_holdout_reuses_evaluation_cohort',
      'promotion_holdout_optimizer_exposed',
      'promotion_holdout_not_sealed',
      'promotion_holdout_not_time_fresh',
    ];
    const proof = {
      ...verifiedProof(),
      status: 'insufficient',
      missingProofs: [],
      blockers: blockerCodes,
      withdrawalConditions: [
        'issue_a_distinct_promotion_holdout',
        'issue_a_holdout_unexposed_to_candidate_and_rubric_selection',
        'seal_the_holdout_before_optimizer_selection',
        'collect_the_holdout_after_optimizer_selection_closes',
      ],
    };

    const result = await resolveWith(resolverReturning({ status: 'resolved', proof }));

    assert.equal(result.status, 'insufficient');
    assert.deepEqual(
      result.blockers.map(({ code }) => code),
      blockerCodes,
    );
  });

  it('rejects proof consumption attributed to any consumer other than F311', async () => {
    const proof = verifiedProof({
      consumerConsumption: {
        ...verifiedProof().consumerConsumption,
        consumerFeatureId: 'F310',
        receipt: ownerRef('F310', 'consumption:receipt-1', SHA_B),
      },
    });

    const result = await resolveWith(resolverReturning({ status: 'resolved', proof }));

    assert.equal(result.status, 'insufficient');
    assert.deepEqual(
      result.blockers.map(({ code }) => code),
      ['consumption_proof_missing'],
    );
  });

  it('fails closed when the owner resolver is unavailable or returns a malformed ref', async () => {
    const unavailable = await resolveWith(resolverReturning({ status: 'insufficient', reason: 'unknown_proof_ref' }));
    assert.deepEqual(
      unavailable.blockers.map(({ code }) => code),
      ['evidence_owner_contract_unavailable'],
    );

    const malformed = verifiedProof();
    malformed.evidenceRole.proof.ref = 'not-a-canonical-owner-ref';
    const invalid = await resolveWith(resolverReturning({ status: 'resolved', proof: malformed }));
    assert.deepEqual(
      invalid.blockers.map(({ code }) => code),
      ['evidence_owner_contract_unavailable'],
    );

    const throwing = createProgramEvidenceProofResolver({
      decisionProofResolver: {
        async resolve() {
          throw new Error('owner store offline');
        },
      },
    });
    const failed = await resolveWith(throwing);
    assert.deepEqual(
      failed.blockers.map(({ code }) => code),
      ['evidence_owner_contract_unavailable'],
    );
  });
});
