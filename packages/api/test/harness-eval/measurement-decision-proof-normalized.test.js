// @ts-check

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

async function moduleUnderTest() {
  return import('../../dist/infrastructure/harness-eval/measurement/measurement-decision-proof-normalized.js');
}

function fixture() {
  const result = {
    resultId: 'public-normalized-result-v1',
    certificateId: 'public-normalized-certificate-v1',
    cohort: { sha256: 'a'.repeat(64) },
    metrics: [
      { role: 'primary_loss', uncertainty: { kind: 'interval' } },
      { role: 'primary_loss', uncertainty: { kind: 'not_estimable' } },
    ],
  };
  const certificate = {
    decisionProcedure: { components: [], versionSetHash: 'b'.repeat(64) },
  };
  const proof = {
    status: 'verified',
    subject: {
      certificateId: result.certificateId,
      resultId: result.resultId,
      evaluationCohortSha256: result.cohort.sha256,
      measurementDecisionStatus: 'insufficient',
    },
    optimizerExposure: {
      proof: { ownerFeatureId: 'F267', sha256: 'c'.repeat(64) },
    },
    promotionHoldout: {
      cohortSha256: 'd'.repeat(64),
      optimizerExposure: { candidateSelection: 'not_exposed', rubricSelection: 'not_exposed' },
      proof: { ownerFeatureId: 'F267' },
    },
  };
  return { certificate, proof, result };
}

/**
 * F267 owner-contract repair — the projection a cross-feature consumer is allowed to read.
 *
 * The suite next door proves the proof chain itself fails closed. This one proves the identities the
 * owner publishes ON TOP of a verified chain: canonical `kind:id` refs instead of repository paths,
 * and nothing defaulted when the owner declared nothing.
 */

describe('F267 normalized measurement decision projection', () => {
  it('publishes canonical owner refs, not repository paths, for what the proof is about', async () => {
    // Cross-feature consumers cannot address a path: it is not stable, it is not an owner ref, and a
    // consumer that wrapped one as if it were would be manufacturing this owner's identity. Before
    // this projection existed, a consumer's only honest report was "F267 publishes no owner refs".
    const { normalizeMeasurementDecisionProof } = await moduleUnderTest();
    const { certificate, proof, result } = fixture();
    const projection = normalizeMeasurementDecisionProof({ proof, result, certificate, ownerFeatureId: 'F267' });
    assert.equal(projection.status, 'normalized', JSON.stringify(projection));
    if (projection.status !== 'normalized') return;
    const normalized = projection.decision;
    assert.deepEqual(normalized.certificateRef, {
      ownerFeatureId: 'F267',
      ownerStateRef: `measurement-certificate:${result.certificateId}`,
    });
    assert.deepEqual(normalized.resultRef, {
      ownerFeatureId: 'F267',
      ownerStateRef: `measurement-result:${result.resultId}`,
    });
    // The evaluation cohort has no owner-assigned id, so it is content-addressed over the sha256
    // the owner already committed to — never over the path.
    assert.equal(normalized.evaluationCohortRef.ownerStateRef, `measurement-cohort:${result.cohort.sha256}`);
    for (const ref of Object.values(normalized).filter((value) => value?.ownerStateRef)) {
      assert.ok(!ref.ownerStateRef.includes('/'), `${ref.ownerStateRef} is still a repository path`);
      assert.match(ref.ownerStateRef, /^[a-z][a-z0-9-]*:[^\s{}[\]"']+$/);
    }

    // `verified` is about the evidence chain. The measurement verdict is carried through unchanged,
    // so a verified proof over an insufficient measurement can never authorise an action.
    assert.equal(normalized.measurementDecisionStatus, proof.subject.measurementDecisionStatus);
    // Holdout exposure is about the HOLDOUT, not the evaluation cohort. This fixture exposes the
    // evaluation cohort to candidate selection while the sealed holdout stays clean, and the
    // projection must not conflate the two.
    assert.equal(normalized.holdoutOptimizerExposed, false);
    // This artifact declares no baseline. Absent must stay absent — never defaulted to the cohort.
    assert.equal('baselineRef' in normalized, false);
    // The weakest primary-loss basis wins: one not-estimable loss makes the decision not estimable.
    assert.equal(normalized.uncertainty?.basis, 'not_estimable');
    assert.deepEqual(normalized.uncertainty?.evidenceRef, normalized.resultRef);
  });

  it('fails closed when an owner id cannot be expressed as a canonical ref', async () => {
    // Sanitising the id would produce a ref that no longer addresses the owner's object, which is
    // worse than refusing: the consumer would persist a plausible-looking identity that resolves to
    // nothing. So the projection refuses outright and the resolver reports it as insufficient.
    const { normalizeMeasurementDecisionProof } = await moduleUnderTest();
    const { certificate, result } = fixture();
    const proof = {
      status: 'verified',
      subject: {
        certificateId: 'public-normalized-certificate-v1',
        resultId: 'result id with a space',
        evaluationCohortSha256: 'a'.repeat(64),
        measurementDecisionStatus: 'usable',
      },
    };
    assert.deepEqual(normalizeMeasurementDecisionProof({ proof, result, certificate, ownerFeatureId: 'F267' }), {
      status: 'unnormalizable',
      reason: 'proof_identity_unnormalizable',
    });
  });
});
