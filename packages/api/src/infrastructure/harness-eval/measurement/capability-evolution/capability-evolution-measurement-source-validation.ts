import { isDeepStrictEqual } from 'node:util';
import type { OwnerTruthRefV1 } from '@cat-cafe/shared';
import { stringify } from 'yaml';

import type { EvolutionProgramProjectionV1 } from '../../../capability-evolution/program-projection.js';
import { validateMeasurementBundleResult } from '../measurement-bundle-validation.js';
import { assessMeasurementDecisionProofCandidate } from '../measurement-decision-proof.js';
import { digest } from '../measurement-decision-proof-files.js';
import { buildMeasurementDecisionProofOwnerObjectSpecs } from '../measurement-decision-proof-owner-object-spec.js';
import type {
  CapabilityEvolutionMeasurementRoleBinding,
  CapabilityEvolutionMeasurementSource,
} from './capability-evolution-measurement-source.js';

export const CAPABILITY_EVOLUTION_MEASUREMENT_SOURCE_ROOT =
  'docs/harness-feedback/measurement-sources/capability-evolution';
const CERTIFICATE_ROOT = 'docs/harness-feedback/certificates';
const RESULT_ROOT = 'docs/harness-feedback/measurement-results';
const OWNER_OBJECT_ROOT = 'docs/harness-feedback/decision-proofs/owner-objects';
const FULL_REVISION = /^[a-f0-9]{40}$/;
const SAFE_ARTIFACT_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

export type CapabilityEvolutionMeasurementRoleName = 'observer' | 'domainOwner' | 'consumer' | 'calibrator';
export type CapabilityEvolutionPersistedRoleName = 'observer' | 'domain_owner' | 'consumer' | 'calibrator';

export function capabilityEvolutionMeasurementSourceId(programId: string): string {
  return programId.replace(':', '-');
}

export function capabilityEvolutionMeasurementSourceArtifactRef(programId: string): string {
  return `${CAPABILITY_EVOLUTION_MEASUREMENT_SOURCE_ROOT}/${capabilityEvolutionMeasurementSourceId(programId)}.yaml`;
}

export function capabilityEvolutionMeasurementSourceRef(projection: EvolutionProgramProjectionV1): OwnerTruthRefV1 {
  return {
    ownerFeatureId: projection.program.objectRef.ownerFeatureId,
    ownerStateRef: `capability-evolution-measurement-source:${capabilityEvolutionMeasurementSourceId(projection.program.programId)}`,
  };
}

function sameRef(left: OwnerTruthRefV1, right: OwnerTruthRefV1): boolean {
  return (
    left.ownerFeatureId === right.ownerFeatureId &&
    left.ownerStateRef === right.ownerStateRef &&
    left.version === right.version
  );
}

function requirePath(ref: string, root: string, id: string): void {
  if (!SAFE_ARTIFACT_ID.test(id)) throw new Error(`unsafe artifact id: ${id}`);
  if (ref !== `${root}/${id}.yaml`) throw new Error(`noncanonical artifact ref: ${ref}`);
}

interface SourceValidationInput {
  manifest: CapabilityEvolutionMeasurementSource;
  projection: EvolutionProgramProjectionV1;
  ownerUserId: string;
}

function validateSourceIdentity(input: SourceValidationInput): void {
  const { manifest, projection } = input;
  if (manifest.sourceId !== capabilityEvolutionMeasurementSourceId(projection.program.programId)) {
    throw new Error('source id mismatch');
  }
  if (manifest.ownerUserId !== input.ownerUserId) throw new Error('source owner user mismatch');
  if (manifest.ownerFeatureId !== projection.program.objectRef.ownerFeatureId) {
    throw new Error('source owner feature mismatch');
  }
  if (!FULL_REVISION.test(manifest.sourceRevision)) throw new Error('source revision mismatch');
  if (
    manifest.program.programId !== projection.program.programId ||
    manifest.program.expectedSequence !== projection.program.sequence ||
    !sameRef(manifest.program.targetRef, projection.program.objectRef) ||
    !sameRef(manifest.program.claimRef, projection.program.claimRef)
  ) {
    throw new Error('source Program binding mismatch');
  }
}

function validateCertificateAndRoles(input: SourceValidationInput): void {
  const { manifest, projection } = input;
  const { certificate, result } = manifest;
  if (certificate.domainId !== 'eval:capability-evolution' || certificate.provenance.featureId !== 'F267') {
    throw new Error('certificate domain or owner mismatch');
  }
  if (certificate.provenance.sourceRevision !== manifest.sourceRevision)
    throw new Error('certificate revision mismatch');
  if (certificate.decision.consumerFeatureId !== 'F311') throw new Error('certificate consumer mismatch');
  const targetId = `${projection.program.objectRef.ownerFeatureId}/${projection.program.objectRef.ownerStateRef}`;
  if (certificate.measurementTarget.id !== targetId) throw new Error('certificate target mismatch');
  const expectedConsumerRef =
    projection.program.valueOwnerRef ??
    ({
      ownerFeatureId: certificate.decision.consumerFeatureId,
      ownerStateRef: projection.program.workspaceId,
    } satisfies OwnerTruthRefV1);
  if (!sameRef(manifest.roles.consumer, expectedConsumerRef)) {
    throw new Error('named consumer role mismatch');
  }
  const roleIdentities = Object.entries(manifest.roles)
    .filter(([name]) => name !== 'overlapJustification')
    .map(([, ref]) => `${(ref as OwnerTruthRefV1).ownerFeatureId}/${(ref as OwnerTruthRefV1).ownerStateRef}`);
  if (new Set(roleIdentities).size !== roleIdentities.length && !manifest.roles.overlapJustification) {
    throw new Error('overlapping measurement roles require an explicit justification');
  }
  validateMeasurementBundleResult(certificate, result);
}

function validateSourceArtifacts(manifest: CapabilityEvolutionMeasurementSource): void {
  const expected = [manifest.result.cohort, ...(manifest.result.baseline ? [manifest.result.baseline] : [])];
  const seen = new Set<string>();
  for (const artifact of manifest.sourceArtifacts) {
    if (artifact.ownerFeatureId !== manifest.ownerFeatureId) {
      throw new Error('source artifact owner mismatch');
    }
    if (seen.has(artifact.ref)) throw new Error('source artifact refs must be unique');
    seen.add(artifact.ref);
  }
  for (const artifact of expected) {
    if (!manifest.sourceArtifacts.some((source) => source.ref === artifact.ref && source.sha256 === artifact.sha256)) {
      throw new Error(`measurement cohort source is not revision-bound: ${artifact.ref}`);
    }
  }
}

function validateProofSubject(manifest: CapabilityEvolutionMeasurementSource): void {
  const { certificate, result, decisionProof } = manifest;
  if (!SAFE_ARTIFACT_ID.test(decisionProof.proofId)) throw new Error('unsafe decision proof id');
  requirePath(decisionProof.subject.certificateRef, CERTIFICATE_ROOT, certificate.certificateId);
  requirePath(decisionProof.subject.resultRef, RESULT_ROOT, result.resultId);
  if (
    decisionProof.subject.certificateId !== certificate.certificateId ||
    decisionProof.subject.resultId !== result.resultId ||
    decisionProof.subject.evaluationCohortRef !== result.cohort.ref ||
    decisionProof.subject.evaluationCohortSha256 !== result.cohort.sha256
  ) {
    throw new Error('decision proof subject mismatch');
  }
  if (
    decisionProof.subject.certificateSha256 !== digest(Buffer.from(stringify(certificate))) ||
    decisionProof.subject.resultSha256 !== digest(Buffer.from(stringify(result)))
  ) {
    throw new Error('decision proof subject hash mismatch');
  }
  // Validate the candidate's bindings even when real owner observations are not complete yet.
  // The resolver is the authority that later emits either `verified` or typed `insufficient`.
  assessMeasurementDecisionProofCandidate(certificate, result, decisionProof);
}

function validateOwnerObjectSet(input: SourceValidationInput): void {
  const { manifest } = input;
  const ownerArtifacts = new Map<string, CapabilityEvolutionMeasurementSource['ownerObjects'][number]['artifact']>();
  for (const entry of manifest.ownerObjects) {
    const ownerObjectId = entry.ref.slice(`${OWNER_OBJECT_ROOT}/`.length, -'.yaml'.length);
    if (
      !entry.ref.startsWith(`${OWNER_OBJECT_ROOT}/`) ||
      !entry.ref.endsWith('.yaml') ||
      !SAFE_ARTIFACT_ID.test(ownerObjectId) ||
      ownerArtifacts.has(entry.ref)
    ) {
      throw new Error('owner object ref is unsafe or duplicated');
    }
    ownerArtifacts.set(entry.ref, entry.artifact);
    if (entry.artifact.ownerUserId !== input.ownerUserId) throw new Error('owner object user mismatch');
    if (entry.artifact.ownerFeatureId !== manifest.ownerFeatureId) {
      throw new Error('decision proof object must be owned by the source feature');
    }
  }
  const specs = buildMeasurementDecisionProofOwnerObjectSpecs(manifest.decisionProof, input.ownerUserId);
  if (specs.length !== manifest.ownerObjects.length) {
    throw new Error('owner object set does not exactly match the decision proof');
  }
  for (const spec of specs) {
    const artifact = ownerArtifacts.get(spec.ref);
    if (
      !artifact ||
      digest(Buffer.from(stringify(artifact))) !== spec.sha256 ||
      !isDeepStrictEqual(artifact, spec.expected)
    ) {
      throw new Error(`owner object mismatch: ${spec.ref}`);
    }
  }
}

export function validateCapabilityEvolutionMeasurementSource(input: SourceValidationInput): void {
  validateSourceIdentity(input);
  validateCertificateAndRoles(input);
  validateSourceArtifacts(input.manifest);
  validateProofSubject(input.manifest);
  validateOwnerObjectSet(input);
}

export function buildCapabilityEvolutionMeasurementRoleArtifacts(input: {
  manifest: CapabilityEvolutionMeasurementSource;
  sourceRef: OwnerTruthRefV1;
  sourceArtifactRef: string;
  sourceSha256: string;
}): Array<{
  name: CapabilityEvolutionMeasurementRoleName;
  persistedName: CapabilityEvolutionPersistedRoleName;
  artifact: CapabilityEvolutionMeasurementRoleBinding;
}> {
  const names: Array<[CapabilityEvolutionMeasurementRoleName, CapabilityEvolutionPersistedRoleName]> = [
    ['observer', 'observer'],
    ['domainOwner', 'domain_owner'],
    ['consumer', 'consumer'],
    ['calibrator', 'calibrator'],
  ];
  return names.map(([name, persistedName]) => ({
    name,
    persistedName,
    artifact: {
      kind: 'f267-capability-evolution-measurement-role',
      schemaVersion: 1,
      programId: input.manifest.program.programId,
      proofRef: `measurement-proof:${input.manifest.decisionProof.proofId}`,
      role: persistedName,
      occupantRef: input.manifest.roles[name],
      ownerUserId: input.manifest.ownerUserId,
      generatedAt: input.manifest.generatedAt,
      source: {
        ...input.sourceRef,
        artifactRef: input.sourceArtifactRef,
        sha256: input.sourceSha256,
      },
    },
  }));
}
