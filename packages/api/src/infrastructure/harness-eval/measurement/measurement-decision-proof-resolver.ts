import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { parse } from 'yaml';

import { CapabilityEvolutionMeasurementSourceSchema } from './capability-evolution/capability-evolution-measurement-source.js';
import {
  createGitCapabilityEvolutionMeasurementSourceStore,
  verifyCapabilityEvolutionMeasurementSourceFromGit,
} from './capability-evolution/capability-evolution-measurement-source-store.js';
import {
  type MeasurementBundleCertificate,
  MeasurementBundleCertificateSchema,
  type MeasurementBundleResult,
  MeasurementBundleResultSchema,
} from './measurement-bundle-schema.js';
import { assessMeasurementDecisionProofCandidate } from './measurement-decision-proof.js';
import { digest, readContainedFile } from './measurement-decision-proof-files.js';
import {
  type NormalizedMeasurementDecisionV1,
  normalizeMeasurementDecisionProof,
} from './measurement-decision-proof-normalized.js';
import { MeasurementDecisionProofOwnerObjectSchema } from './measurement-decision-proof-owner-object.js';
import { buildMeasurementDecisionProofOwnerObjectSpecs } from './measurement-decision-proof-owner-object-spec.js';
import {
  type MeasurementDecisionProof,
  type MeasurementDecisionProofCandidateAssessment,
  type MeasurementDecisionProofRecord,
  MeasurementDecisionProofRecordSchema,
} from './measurement-decision-proof-schema.js';

const PROOF_REF_PREFIX = 'measurement-proof:';
const PROOF_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const PROOF_RECORD_ROOT = 'docs/harness-feedback/decision-proofs/records';
const OWNER_OBJECT_ROOT = 'docs/harness-feedback/decision-proofs/owner-objects';
const CERTIFICATE_ROOT = 'docs/harness-feedback/certificates';
const RESULT_ROOT = 'docs/harness-feedback/measurement-results';
const MEASUREMENT_SOURCE_ROOT = 'docs/harness-feedback/measurement-sources';

export interface MeasurementDecisionProofRef {
  ownerFeatureId: string;
  ownerStateRef: string;
}

export type MeasurementDecisionProofResolution =
  | {
      status: 'resolved';
      proof: MeasurementDecisionProof;
      /**
       * Owner-published canonical identities for everything the proof is about. Present only on a
       * `verified` proof: an unverified evidence chain has nothing whose identity F267 is willing to
       * publish. Cross-feature consumers read THIS and never the path-shaped `proof.subject` fields.
       */
      normalized?: NormalizedMeasurementDecisionV1;
    }
  | {
      status: 'insufficient';
      reason:
        | 'invalid_proof_ref'
        | 'unknown_proof_ref'
        | 'proof_owner_mismatch'
        | 'invalid_proof_record'
        | 'proof_source_mismatch'
        | 'proof_store_unavailable'
        /** The owner's own ids cannot be expressed as canonical refs; fail closed, never sanitise. */
        | 'proof_identity_unnormalizable';
    };

export interface MeasurementDecisionProofResolver {
  resolve(input: {
    ownerUserId: string;
    evidenceProofRef: MeasurementDecisionProofRef;
  }): Promise<MeasurementDecisionProofResolution>;
}

type InsufficientResolution = Extract<MeasurementDecisionProofResolution, { status: 'insufficient' }>;
type SourceAttestation = NonNullable<MeasurementDecisionProofRecord['sourceAttestations']>[number];

function insufficient(reason: InsufficientResolution['reason']): InsufficientResolution {
  return { status: 'insufficient', reason };
}

function proofIdFromRef(ref: MeasurementDecisionProofRef): string | undefined {
  if (ref.ownerFeatureId !== 'F267' || !ref.ownerStateRef.startsWith(PROOF_REF_PREFIX)) return undefined;
  const proofId = ref.ownerStateRef.slice(PROOF_REF_PREFIX.length);
  return PROOF_ID_PATTERN.test(proofId) ? proofId : undefined;
}

async function readProofRecord(
  repoRoot: string,
  proofId: string,
): Promise<{ status: 'record'; record: MeasurementDecisionProofRecord } | InsufficientResolution> {
  const ref = `${PROOF_RECORD_ROOT}/${proofId}.yaml`;
  const source = await readContainedFile(repoRoot, ref, PROOF_RECORD_ROOT);
  if (source.status !== 'ok') {
    return insufficient(source.status === 'missing' ? 'unknown_proof_ref' : 'proof_store_unavailable');
  }

  try {
    return {
      status: 'record',
      record: MeasurementDecisionProofRecordSchema.parse(parse(source.bytes.toString('utf8'))),
    };
  } catch {
    return insufficient('invalid_proof_record');
  }
}

function validateRecordIdentity(input: {
  record: MeasurementDecisionProofRecord;
  proofId: string;
  evidenceProofRef: MeasurementDecisionProofRef;
  ownerUserId: string;
}): InsufficientResolution | undefined {
  if (
    input.record.proofRef !== input.evidenceProofRef.ownerStateRef ||
    input.record.candidate.proofId !== input.proofId
  ) {
    return insufficient('invalid_proof_record');
  }
  if (input.record.ownerUserId !== input.ownerUserId) return insufficient('proof_owner_mismatch');
  return undefined;
}

async function validateOwnerObjects(
  repoRoot: string,
  record: MeasurementDecisionProofRecord,
): Promise<InsufficientResolution | undefined> {
  try {
    for (const spec of buildMeasurementDecisionProofOwnerObjectSpecs(record.candidate, record.ownerUserId)) {
      const source = await readContainedFile(repoRoot, spec.ref, OWNER_OBJECT_ROOT);
      if (source.status !== 'ok' || digest(source.bytes) !== spec.sha256) {
        return insufficient('proof_source_mismatch');
      }
      const actual = MeasurementDecisionProofOwnerObjectSchema.parse(parse(source.bytes.toString('utf8')));
      if (!isDeepStrictEqual(actual, spec.expected)) return insufficient('proof_source_mismatch');
    }
    return undefined;
  } catch {
    return insufficient('proof_source_mismatch');
  }
}

async function readLegacySourceManifest(
  repoRoot: string,
  attestation: SourceAttestation,
): Promise<ReturnType<typeof CapabilityEvolutionMeasurementSourceSchema.parse> | undefined> {
  const source = await readContainedFile(repoRoot, attestation.artifactRef, MEASUREMENT_SOURCE_ROOT);
  if (source.status !== 'ok' || digest(source.bytes) !== attestation.sha256) return undefined;
  return CapabilityEvolutionMeasurementSourceSchema.parse(parse(source.bytes.toString('utf8')));
}

async function readGitAttestedSourceManifest(
  repoRoot: string,
  attestation: SourceAttestation,
): Promise<ReturnType<typeof CapabilityEvolutionMeasurementSourceSchema.parse> | undefined> {
  if (attestation.manifestRevision === undefined) return undefined;
  const sourceStore = createGitCapabilityEvolutionMeasurementSourceStore({
    repoRoot,
    mainRef: attestation.manifestRevision,
    fetchMain: false,
  });
  const source = await sourceStore.readOnMain(attestation.artifactRef);
  if (
    source.status !== 'ok' ||
    source.manifestRevision !== attestation.manifestRevision ||
    digest(source.bytes) !== attestation.sha256
  ) {
    return undefined;
  }
  const manifest = CapabilityEvolutionMeasurementSourceSchema.parse(parse(source.bytes.toString('utf8')));
  const verification = await verifyCapabilityEvolutionMeasurementSourceFromGit({
    repoRoot,
    manifest,
    manifestRevision: attestation.manifestRevision,
  });
  return verification.status === 'verified' ? manifest : undefined;
}

function sourceManifestMatchesRecord(
  manifest: ReturnType<typeof CapabilityEvolutionMeasurementSourceSchema.parse>,
  attestation: SourceAttestation,
  record: MeasurementDecisionProofRecord,
  certificate: MeasurementBundleCertificate,
  result: MeasurementBundleResult,
): boolean {
  return (
    manifest.ownerUserId === record.ownerUserId &&
    manifest.ownerFeatureId === attestation.ownerFeatureId &&
    `capability-evolution-measurement-source:${manifest.sourceId}` === attestation.ownerStateRef &&
    isDeepStrictEqual(manifest.decisionProof, record.candidate) &&
    isDeepStrictEqual(manifest.certificate, certificate) &&
    isDeepStrictEqual(manifest.result, result)
  );
}

async function validateSourceAttestations(
  repoRoot: string,
  record: MeasurementDecisionProofRecord,
  certificate: MeasurementBundleCertificate,
  result: MeasurementBundleResult,
): Promise<InsufficientResolution | undefined> {
  const requiresGitSourceAttestation = certificate.domainId === 'eval:capability-evolution';
  if (record.sourceAttestations === undefined) {
    return requiresGitSourceAttestation ? insufficient('proof_source_mismatch') : undefined;
  }
  try {
    for (const attestation of record.sourceAttestations) {
      const manifest = requiresGitSourceAttestation
        ? await readGitAttestedSourceManifest(repoRoot, attestation)
        : await readLegacySourceManifest(repoRoot, attestation);
      if (!manifest || !sourceManifestMatchesRecord(manifest, attestation, record, certificate, result)) {
        return insufficient('proof_source_mismatch');
      }
    }
    return undefined;
  } catch {
    return insufficient('proof_source_mismatch');
  }
}

function authorizeCandidateAssessment(
  assessment: MeasurementDecisionProofCandidateAssessment,
): MeasurementDecisionProof {
  if (assessment.status === 'candidate_sufficient') {
    const { kind: _kind, status: _status, ...payload } = assessment;
    return {
      ...payload,
      kind: 'f267-measurement-decision-proof',
      status: 'verified',
    };
  }

  const { kind: _kind, status: _status, ...payload } = assessment;
  return {
    ...payload,
    kind: 'f267-measurement-decision-proof',
    status: 'insufficient',
  };
}

async function assessRecord(
  repoRoot: string,
  record: MeasurementDecisionProofRecord,
  ownerFeatureId: string,
): Promise<MeasurementDecisionProofResolution> {
  const [certificateSource, resultSource] = await Promise.all([
    readContainedFile(repoRoot, record.candidate.subject.certificateRef, CERTIFICATE_ROOT),
    readContainedFile(repoRoot, record.candidate.subject.resultRef, RESULT_ROOT),
  ]);
  if (certificateSource.status !== 'ok' || resultSource.status !== 'ok') {
    return insufficient('proof_source_mismatch');
  }
  if (
    digest(certificateSource.bytes) !== record.candidate.subject.certificateSha256 ||
    digest(resultSource.bytes) !== record.candidate.subject.resultSha256
  ) {
    return insufficient('proof_source_mismatch');
  }

  let resultDocument: MeasurementBundleResult;
  let certificateDocument: MeasurementBundleCertificate;
  try {
    resultDocument = MeasurementBundleResultSchema.parse(parse(resultSource.bytes.toString('utf8')));
    certificateDocument = MeasurementBundleCertificateSchema.parse(parse(certificateSource.bytes.toString('utf8')));
  } catch {
    return insufficient('proof_source_mismatch');
  }

  const sourceFailure = await validateSourceAttestations(repoRoot, record, certificateDocument, resultDocument);
  if (sourceFailure) return sourceFailure;

  const ownerObjectFailure = await validateOwnerObjects(repoRoot, record);
  if (ownerObjectFailure) return ownerObjectFailure;

  try {
    const assessment = assessMeasurementDecisionProofCandidate(certificateDocument, resultDocument, record.candidate);
    const proof = authorizeCandidateAssessment(assessment);
    if (proof.status !== 'verified') return { status: 'resolved', proof };
    const normalized = normalizeMeasurementDecisionProof({
      proof,
      result: resultDocument,
      certificate: certificateDocument,
      ownerFeatureId,
    });
    if (normalized.status !== 'normalized') return insufficient('proof_identity_unnormalizable');
    return { status: 'resolved', proof, normalized: normalized.decision };
  } catch {
    return insufficient('proof_source_mismatch');
  }
}

export function createFileMeasurementDecisionProofResolver(input: {
  repoRoot: string;
}): MeasurementDecisionProofResolver {
  const repoRoot = resolve(input.repoRoot);

  return {
    async resolve({ ownerUserId, evidenceProofRef }) {
      const proofId = proofIdFromRef(evidenceProofRef);
      if (!proofId) return insufficient('invalid_proof_ref');

      const recordResult = await readProofRecord(repoRoot, proofId);
      if (recordResult.status === 'insufficient') return recordResult;

      const identityFailure = validateRecordIdentity({
        record: recordResult.record,
        proofId,
        evidenceProofRef,
        ownerUserId,
      });
      if (identityFailure) return identityFailure;
      return assessRecord(repoRoot, recordResult.record, evidenceProofRef.ownerFeatureId);
    },
  };
}
