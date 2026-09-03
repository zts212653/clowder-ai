import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { before, describe, it } from 'node:test';

import { parse } from 'yaml';

/**
 * F311 Phase 3 × F267 — the composition seam.
 *
 * The unit tests stub the owner. This one runs F267's REAL normalization over a REAL committed
 * measurement result and feeds the result through the production owner resolver into the Program
 * service, because the failure this guards against is exactly the one that survived several review
 * rounds: each side passing its own tests while the identities they exchange do not line up.
 *
 * File IO is the only thing left out — `measurement-decision-proof-resolver.test.js` covers the
 * bytes, hashes, containment and symlink escapes end to end.
 */

const RESULT_REF = 'docs/harness-feedback/measurement-results/f267-friction-2026-07-18.yaml';
const repoRoot = resolve(import.meta.dirname, '../../..');
const proofRef = { ownerFeatureId: 'F267', ownerStateRef: 'measurement-proof:f311-phase3-join' };

let normalizeMeasurementDecisionProof;
let createProgramEvaluationOwnerResolver;
let committedResult;
let committedCertificate;

before(async () => {
  ({ normalizeMeasurementDecisionProof } = await import(
    '../dist/infrastructure/harness-eval/measurement/measurement-decision-proof-normalized.js'
  ));
  ({ createProgramEvaluationOwnerResolver } = await import(
    '../dist/infrastructure/capability-evolution/program-evaluation-owner-resolver.js'
  ));
  committedResult = parse((await readFile(resolve(repoRoot, RESULT_REF))).toString('utf8'));
  committedCertificate = parse((await readFile(resolve(repoRoot, committedResult.certificateRef))).toString('utf8'));
});

const ownerEvidenceRef = (ownerFeatureId) => ({
  ownerFeatureId,
  ref: 'docs/harness-feedback/decision-proofs/owner-objects/x.yaml',
  sha256: 'a'.repeat(64),
});

function verifiedProof(overrides = {}) {
  return {
    kind: 'f267-measurement-decision-proof',
    schemaVersion: 1,
    status: 'verified',
    proofId: 'f311-phase3-join',
    generatedAt: '2026-09-01T07:00:00.000Z',
    subject: {
      certificateId: committedResult.certificateId,
      certificateRef: committedResult.certificateRef,
      certificateSha256: 'b'.repeat(64),
      resultId: committedResult.resultId,
      resultRef: RESULT_REF,
      resultSha256: 'c'.repeat(64),
      evaluationCohortRef: committedResult.cohort.ref,
      evaluationCohortSha256: committedResult.cohort.sha256,
      measurementDecisionStatus: committedResult.decision.status,
    },
    evidenceRole: {
      cohortRef: committedResult.cohort.ref,
      cohortSha256: committedResult.cohort.sha256,
      roles: ['attribution'],
      proof: ownerEvidenceRef('F267'),
    },
    optimizerExposure: {
      cohortRef: committedResult.cohort.ref,
      cohortSha256: committedResult.cohort.sha256,
      candidateSelection: 'not_exposed',
      rubricSelection: 'not_exposed',
      proof: ownerEvidenceRef('F267'),
    },
    promotionHoldout: {
      cohortRef: 'docs/harness-feedback/decision-proofs/owner-objects/holdout.yaml',
      cohortSha256: 'd'.repeat(64),
      window: { startMs: 300, endMs: 400 },
      independence: { kind: 'time_fresh', optimizerSelectionCutoffMs: 250 },
      optimizerExposure: { candidateSelection: 'not_exposed', rubricSelection: 'not_exposed' },
      proof: ownerEvidenceRef('F267'),
    },
    ...overrides,
  };
}

/** Stands in for file IO only: the normalization below is F267's real implementation. */
function proofResolver(resolution) {
  return { resolve: async () => resolution };
}

function resolvedFrom(proof, result = committedResult) {
  const normalized = normalizeMeasurementDecisionProof({
    proof,
    result,
    certificate: committedCertificate,
    ownerFeatureId: 'F267',
  });
  assert.equal(normalized.status, 'normalized', JSON.stringify(normalized));
  return { status: 'resolved', proof, normalized: normalized.decision };
}

const resolveThrough = (resolution) =>
  createProgramEvaluationOwnerResolver({ decisionProofResolver: proofResolver(resolution) }).resolveMeasurement({
    ownerUserId: 'operator',
    evidenceProofRef: proofRef,
  });

describe('F311 Phase 3 owner join over real F267 normalization', () => {
  it('hands the Program canonical owner refs, never repository paths', async () => {
    const resolution = await resolveThrough(resolvedFrom(verifiedProof()));
    assert.equal(resolution.status, 'ready', JSON.stringify(resolution));
    const { bundle } = resolution;
    assert.deepEqual(bundle.certificateRef, {
      ownerFeatureId: 'F267',
      ownerStateRef: `measurement-certificate:${committedResult.certificateId}`,
    });
    assert.deepEqual(bundle.resultRef, {
      ownerFeatureId: 'F267',
      ownerStateRef: `measurement-result:${committedResult.resultId}`,
    });
    assert.equal(bundle.frozenCohortRef.ownerStateRef, `measurement-cohort:${committedResult.cohort.sha256}`);
    for (const ref of [bundle.certificateRef, bundle.resultRef, bundle.frozenCohortRef, bundle.exposureProofRef]) {
      assert.match(ref.ownerStateRef, /^[a-z][a-z0-9-]*:[^\s{}[\]"']+$/);
      assert.ok(!ref.ownerStateRef.includes('/'), `${ref.ownerStateRef} leaked a repository path`);
    }
  });

  it('carries the owner measurement verdict through untouched, and does not default what is absent', async () => {
    const resolution = await resolveThrough(resolvedFrom(verifiedProof()));
    // `verified` is about the evidence chain. This committed artifact's measurement is insufficient
    // and a verified proof over it must stay insufficient — proof verification is not authorisation.
    assert.equal(committedResult.decision.status, 'insufficient');
    assert.equal(resolution.bundle.ownerDecisionStatus, 'insufficient');
    // This artifact declares no baseline; the join must report nothing rather than reuse the cohort.
    assert.equal('baselineRef' in resolution.bundle, false);
    // Its primary loss is not estimable, and that is what the Program must be told.
    assert.equal(resolution.bundle.uncertainty.basis, 'not_estimable');
    assert.deepEqual(resolution.bundle.uncertainty.evidenceRef, resolution.bundle.resultRef);
  });

  it('leaves holdout exposure absent rather than false when the owner proves nothing', async () => {
    // Absent must not read as safe. A `false` here would let the intervention gate treat an
    // unproven holdout as clean.
    const { promotionHoldout: _dropped, ...withoutHoldout } = verifiedProof();
    const resolution = await resolveThrough(resolvedFrom(withoutHoldout));
    assert.equal(resolution.status, 'ready');
    assert.equal('holdoutOptimizerExposed' in resolution.bundle, false);
  });

  it('refuses evidence the owner did not tag for attribution', async () => {
    const proof = verifiedProof();
    proof.evidenceRole = { ...proof.evidenceRole, roles: ['discovery'] };
    const resolution = await resolveThrough(resolvedFrom(proof));
    assert.equal(resolution.status, 'unavailable');
    assert.match(resolution.reason, /not owner-tagged for attribution/);
  });

  it('fails closed on an unverified proof and on a verified proof with no published identities', async () => {
    const unverified = await resolveThrough({
      status: 'resolved',
      proof: { ...verifiedProof(), status: 'insufficient' },
    });
    assert.equal(unverified.status, 'unavailable');
    assert.match(unverified.reason, /not verified/);

    // A verified proof whose identities the owner could not publish is an owner-side gap; the join
    // must surface it rather than fall back to the path-shaped subject fields.
    const unpublished = await resolveThrough({ status: 'resolved', proof: verifiedProof() });
    assert.equal(unpublished.status, 'unavailable');
    assert.match(unpublished.reason, /no canonical refs/);

    const missing = await resolveThrough({ status: 'insufficient', reason: 'unknown_proof_ref' });
    assert.equal(missing.status, 'unavailable');
    assert.equal(missing.reason, 'unknown_proof_ref');
  });
});
