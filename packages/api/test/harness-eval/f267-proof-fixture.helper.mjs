// @ts-check

/**
 * Shared fixture for F267 decision-proof resolution.
 *
 * It builds a complete, hash-consistent owner chain in a throwaway repository root from the REAL
 * committed certificate and result bytes, so every test that uses it exercises the owner's actual
 * artifacts rather than a hand-written stand-in. Extracted so the resolver's fail-closed suite and
 * the normalized-projection suite can share one source of truth instead of drifting apart.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { parse, stringify } from 'yaml';

export const CERTIFICATE_REF = 'docs/harness-feedback/certificates/f267-memory-search-quality.yaml';
export const RESULT_REF =
  'docs/harness-feedback/measurement-results/f267-memory-search-quality-negative-control-v1.yaml';
export const OWNER_ROOT = 'docs/harness-feedback/decision-proofs/owner-objects';
export const PROOF_ID = 'f311-ac23-decision-proof-v1';
export const PROOF_REF = { ownerFeatureId: 'F267', ownerStateRef: `measurement-proof:${PROOF_ID}` };
export const OWNER_KEYS = [
  'evidenceRole',
  'consumerReceipt',
  'optimizerExposure',
  'holdoutCohort',
  'holdoutProof',
  'holdoutSeal',
];
export const sourceRepoRoot = resolve(import.meta.dirname, '../../../..');

export async function moduleUnderTest() {
  return import('../../dist/infrastructure/harness-eval/measurement/measurement-decision-proof-resolver.js');
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeOwnedFile(repoRoot, ref, bytes) {
  const target = join(repoRoot, ref);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

function ownerObject(objectType, ownerFeatureId, payload) {
  return {
    kind: 'f267-measurement-decision-proof-owner-object',
    schemaVersion: 1,
    objectType,
    ownerUserId: 'operator',
    ownerFeatureId,
    ...payload,
  };
}

export async function fixture(options = {}) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'f267-proof-resolver-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'f267-proof-outside-'));
  const certificateBytes = await readFile(resolve(sourceRepoRoot, CERTIFICATE_REF));
  const resultBytes = await readFile(resolve(sourceRepoRoot, RESULT_REF));
  const certificate = parse(certificateBytes.toString('utf8'));
  const result = parse(resultBytes.toString('utf8'));
  const window = { startMs: 300, endMs: 400 };
  const refs = Object.fromEntries(OWNER_KEYS.map((key) => [key, `${OWNER_ROOT}/${key}.yaml`]));
  const objects = {
    evidenceRole: ownerObject('evidence_role', 'F267', {
      cohortRef: result.cohort.ref,
      cohortSha256: result.cohort.sha256,
      roles: ['validation'],
    }),
    consumerReceipt: ownerObject('consumer_consumption', certificate.decision.consumerFeatureId, {
      consumerFeatureId: certificate.decision.consumerFeatureId,
      consumerOwnerCatId: certificate.decision.consumerOwnerCatId,
      resultId: result.resultId,
      consumedAt: '2026-09-01T07:05:00.000Z',
    }),
    optimizerExposure: ownerObject('optimizer_exposure', 'F267', {
      cohortRef: result.cohort.ref,
      cohortSha256: result.cohort.sha256,
      candidateSelection: 'exposed',
      rubricSelection: 'not_exposed',
    }),
    holdoutCohort: ownerObject('promotion_holdout_cohort', 'F267', {
      cohortRef: refs.holdoutCohort,
      window,
    }),
  };
  const bytes = Object.fromEntries(Object.entries(objects).map(([key, value]) => [key, Buffer.from(stringify(value))]));
  const cohortSha256 = sha256(bytes.holdoutCohort);
  objects.holdoutSeal = ownerObject('promotion_holdout_seal', 'F267', {
    cohortRef: refs.holdoutCohort,
    cohortSha256,
    sealedAtMs: 200,
    optimizerSelectionCutoffMs: 250,
  });
  bytes.holdoutSeal = Buffer.from(stringify(objects.holdoutSeal));
  const sealRef = { ownerFeatureId: 'F267', ref: refs.holdoutSeal, sha256: sha256(bytes.holdoutSeal) };
  objects.holdoutProof = ownerObject('promotion_holdout', 'F267', {
    cohortRef: refs.holdoutCohort,
    cohortSha256,
    window,
    independence: { kind: 'sealed', sealedAtMs: 200, optimizerSelectionCutoffMs: 250, seal: sealRef },
    optimizerExposure: { candidateSelection: 'not_exposed', rubricSelection: 'not_exposed' },
  });
  bytes.holdoutProof = Buffer.from(stringify(objects.holdoutProof));
  for (const key of OWNER_KEYS) await writeOwnedFile(repoRoot, refs[key], bytes[key]);
  await writeOwnedFile(repoRoot, CERTIFICATE_REF, certificateBytes);
  await writeOwnedFile(repoRoot, RESULT_REF, resultBytes);

  const proof = {
    kind: 'f267-measurement-decision-proof-candidate',
    schemaVersion: 1,
    proofId: PROOF_ID,
    generatedAt: '2026-09-01T07:00:00.000Z',
    subject: {
      certificateId: certificate.certificateId,
      certificateRef: CERTIFICATE_REF,
      certificateSha256: sha256(certificateBytes),
      resultId: result.resultId,
      resultRef: RESULT_REF,
      resultSha256: sha256(resultBytes),
      evaluationCohortRef: result.cohort.ref,
      evaluationCohortSha256: result.cohort.sha256,
    },
    evidenceRole: {
      cohortRef: result.cohort.ref,
      cohortSha256: result.cohort.sha256,
      roles: ['validation'],
      proof: { ownerFeatureId: 'F267', ref: refs.evidenceRole, sha256: sha256(bytes.evidenceRole) },
    },
    consumerConsumption: {
      consumerFeatureId: certificate.decision.consumerFeatureId,
      consumerOwnerCatId: certificate.decision.consumerOwnerCatId,
      resultId: result.resultId,
      consumedAt: '2026-09-01T07:05:00.000Z',
      receipt: {
        ownerFeatureId: certificate.decision.consumerFeatureId,
        ref: refs.consumerReceipt,
        sha256: sha256(bytes.consumerReceipt),
      },
    },
    optimizerExposure: {
      cohortRef: result.cohort.ref,
      cohortSha256: result.cohort.sha256,
      candidateSelection: 'exposed',
      rubricSelection: 'not_exposed',
      proof: { ownerFeatureId: 'F267', ref: refs.optimizerExposure, sha256: sha256(bytes.optimizerExposure) },
    },
    promotionHoldout: {
      cohortRef: refs.holdoutCohort,
      cohortSha256,
      window,
      independence: { kind: 'sealed', sealedAtMs: 200, optimizerSelectionCutoffMs: 250, seal: sealRef },
      optimizerExposure: { candidateSelection: 'not_exposed', rubricSelection: 'not_exposed' },
      proof: { ownerFeatureId: 'F267', ref: refs.holdoutProof, sha256: sha256(bytes.holdoutProof) },
    },
  };
  const record = {
    kind: 'f267-measurement-decision-proof-record',
    schemaVersion: 1,
    proofRef: PROOF_REF.ownerStateRef,
    ownerUserId: options.ownerUserId ?? 'operator',
    candidate: proof,
  };
  const recordRef = `docs/harness-feedback/decision-proofs/records/${PROOF_ID}.yaml`;
  await writeOwnedFile(repoRoot, recordRef, stringify(record));
  return {
    repoRoot,
    outsideRoot,
    refs,
    bytes,
    recordRef,
    cleanup: async () => {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    },
  };
}

export async function resolveFixture(testFixture) {
  const { createFileMeasurementDecisionProofResolver } = await moduleUnderTest();
  const resolver = createFileMeasurementDecisionProofResolver({ repoRoot: testFixture.repoRoot });
  return resolver.resolve({ ownerUserId: 'operator', evidenceProofRef: PROOF_REF });
}

export async function replaceWithOutsideSymlink(testFixture, ref) {
  const target = join(testFixture.repoRoot, ref);
  const outside = join(testFixture.outsideRoot, 'escaped.yaml');
  await writeFile(outside, await readFile(target));
  await unlink(target);
  await symlink(outside, target);
}
