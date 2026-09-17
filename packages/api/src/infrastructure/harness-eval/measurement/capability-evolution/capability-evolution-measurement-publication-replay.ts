import { isDeepStrictEqual } from 'node:util';

import type { OwnerTruthRefV1 } from '@cat-cafe/shared';
import { parse, stringify } from 'yaml';

import type { GitPublisher } from '../../publish-verdict/types.js';
import { digest, readContainedFile } from '../measurement-decision-proof-files.js';
import { createFileMeasurementDecisionProofResolver } from '../measurement-decision-proof-resolver.js';
import { MeasurementDecisionProofRecordSchema } from '../measurement-decision-proof-schema.js';
import type { CapabilityEvolutionMeasurementSource } from './capability-evolution-measurement-source.js';
import type { CapabilityEvolutionMeasurementRoleName } from './capability-evolution-measurement-source-validation.js';
import { buildCapabilityEvolutionMeasurementRoleArtifacts } from './capability-evolution-measurement-source-validation.js';

const PROOF_RECORD_ROOT = 'docs/harness-feedback/decision-proofs/records';
const ROLE_ROOT = 'docs/harness-feedback/measurement-roles';

type Roles = ReturnType<typeof buildCapabilityEvolutionMeasurementRoleArtifacts>;

function artifactPaths(manifest: CapabilityEvolutionMeasurementSource, roles: Roles): string[] {
  return [
    manifest.decisionProof.subject.certificateRef,
    manifest.decisionProof.subject.resultRef,
    ...manifest.ownerObjects.map((entry) => entry.ref),
    ...roles.map((role) => `${ROLE_ROOT}/${manifest.decisionProof.proofId}/${role.persistedName}.yaml`),
    `${PROOF_RECORD_ROOT}/${manifest.decisionProof.proofId}.yaml`,
  ];
}

async function validateReplayArtifacts(input: {
  worktreeRoot: string;
  ownerUserId: string;
  sourceRef: OwnerTruthRefV1;
  artifactRef: string;
  sourceSha256: string;
  manifest: CapabilityEvolutionMeasurementSource;
  evidenceProofRef: OwnerTruthRefV1;
  roles: Roles;
}): Promise<'verified' | 'insufficient'> {
  const recordRef = `${PROOF_RECORD_ROOT}/${input.manifest.decisionProof.proofId}.yaml`;
  const recordSource = await readContainedFile(input.worktreeRoot, recordRef, PROOF_RECORD_ROOT);
  if (recordSource.status !== 'ok') throw new Error('existing publication proof record is unavailable');
  const record = MeasurementDecisionProofRecordSchema.parse(parse(recordSource.bytes.toString('utf8')));
  const attestation = record.sourceAttestations?.[0];
  if (
    record.ownerUserId !== input.ownerUserId ||
    !isDeepStrictEqual(record.candidate, input.manifest.decisionProof) ||
    record.sourceAttestations?.length !== 1 ||
    !attestation ||
    attestation.ownerFeatureId !== input.sourceRef.ownerFeatureId ||
    attestation.ownerStateRef !== input.sourceRef.ownerStateRef ||
    attestation.artifactRef !== input.artifactRef ||
    attestation.sha256 !== input.sourceSha256
  ) {
    throw new Error('existing publication proof does not match the current immutable owner source');
  }

  for (const role of input.roles) {
    const roleRef = `${ROLE_ROOT}/${input.manifest.decisionProof.proofId}/${role.persistedName}.yaml`;
    const source = await readContainedFile(input.worktreeRoot, roleRef, ROLE_ROOT);
    if (source.status !== 'ok' || digest(source.bytes) !== digest(Buffer.from(stringify(role.artifact)))) {
      throw new Error(`existing publication role mismatch: ${role.name}`);
    }
  }
  const resolution = await createFileMeasurementDecisionProofResolver({ repoRoot: input.worktreeRoot }).resolve({
    ownerUserId: input.ownerUserId,
    evidenceProofRef: input.evidenceProofRef,
  });
  if (resolution.status !== 'resolved') {
    throw new Error(`existing publication proof did not resolve: ${resolution.reason}`);
  }
  return resolution.proof.status;
}

export async function resolveCapabilityEvolutionMeasurementPublication(input: {
  gitPublisher: GitPublisher;
  branchName: string;
  sourceMessageId: string;
  ownerUserId: string;
  sourceRef: OwnerTruthRefV1;
  artifactRef: string;
  sourceSha256: string;
  manifest: CapabilityEvolutionMeasurementSource;
  evidenceProofRef: OwnerTruthRefV1;
  roles: Roles;
}): Promise<{ commitSha: string; prUrl: string; proofStatus: 'verified' | 'insufficient' } | undefined> {
  if (!input.gitPublisher.resolvePublishedOnIsolatedWorktree) return undefined;
  let proofStatus: 'verified' | 'insufficient' | undefined;
  const published = await input.gitPublisher.resolvePublishedOnIsolatedWorktree({
    branchName: input.branchName,
    sourceMessageId: input.sourceMessageId,
    expectedPaths: artifactPaths(input.manifest, input.roles),
    validate: async (worktreeRoot) => {
      proofStatus = await validateReplayArtifacts({ ...input, worktreeRoot });
    },
  });
  if (!published) return undefined;
  if (!proofStatus) throw new Error('existing publication completed without resolving the issued proof');
  return { ...published, proofStatus };
}

function capabilityEvolutionMeasurementRoleRefs(
  proofId: string,
  roles: Roles,
): Record<CapabilityEvolutionMeasurementRoleName, OwnerTruthRefV1> {
  return Object.fromEntries(
    roles.map((role) => [
      role.name,
      { ownerFeatureId: 'F267', ownerStateRef: `measurement-role:${proofId}:${role.persistedName}` },
    ]),
  ) as Record<CapabilityEvolutionMeasurementRoleName, OwnerTruthRefV1>;
}

export function capabilityEvolutionMeasurementPublicationFields(input: {
  sourceRef: OwnerTruthRefV1;
  manifest: CapabilityEvolutionMeasurementSource;
  evidenceProofRef: OwnerTruthRefV1;
  roles: Roles;
  proofStatus: 'verified' | 'insufficient';
  commitSha: string;
  prUrl: string;
}) {
  return {
    sourceRef: input.sourceRef,
    certificateRef: {
      ownerFeatureId: 'F267',
      ownerStateRef: `measurement-certificate:${input.manifest.certificate.certificateId}`,
    },
    measurementRoleRefs: capabilityEvolutionMeasurementRoleRefs(input.manifest.decisionProof.proofId, input.roles),
    resultRef: {
      ownerFeatureId: 'F267',
      ownerStateRef: `measurement-result:${input.manifest.result.resultId}`,
    },
    evidenceProofRef: input.evidenceProofRef,
    measurementDecisionStatus: input.manifest.result.decision.status,
    proofStatus: input.proofStatus,
    commitSha: input.commitSha,
    prUrl: input.prUrl,
  };
}
