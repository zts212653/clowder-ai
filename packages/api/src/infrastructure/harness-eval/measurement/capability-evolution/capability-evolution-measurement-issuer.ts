import type { OwnerTruthRefV1 } from '@cat-cafe/shared';
import { parse } from 'yaml';

import type { EvolutionProgramProjectionV1 } from '../../../capability-evolution/program-projection.js';
import type { GitPublisher } from '../../publish-verdict/types.js';
import { persistImmutableMeasurementArtifact } from '../measurement-artifact-files.js';
import { digest, readContainedFile } from '../measurement-decision-proof-files.js';
import { createFileMeasurementDecisionProofResolver } from '../measurement-decision-proof-resolver.js';
import { MeasurementDecisionProofRecordSchema } from '../measurement-decision-proof-schema.js';
import { createBoundedIdempotentRunner } from './bounded-idempotent-runner.js';
import {
  capabilityEvolutionMeasurementPublicationFields,
  resolveCapabilityEvolutionMeasurementPublication,
} from './capability-evolution-measurement-publication-replay.js';
import type { CapabilityEvolutionMeasurementSource } from './capability-evolution-measurement-source.js';
import { CapabilityEvolutionMeasurementSourceSchema } from './capability-evolution-measurement-source.js';
import {
  type CapabilityEvolutionMeasurementSourceStore,
  createGitCapabilityEvolutionMeasurementSourceStore,
} from './capability-evolution-measurement-source-store.js';
import {
  buildCapabilityEvolutionMeasurementRoleArtifacts,
  CAPABILITY_EVOLUTION_MEASUREMENT_SOURCE_ROOT,
  type CapabilityEvolutionMeasurementRoleName,
  capabilityEvolutionMeasurementSourceArtifactRef,
  capabilityEvolutionMeasurementSourceRef,
  validateCapabilityEvolutionMeasurementSource,
} from './capability-evolution-measurement-source-validation.js';

const PROOF_RECORD_ROOT = 'docs/harness-feedback/decision-proofs/records';
const ROLE_ROOT = 'docs/harness-feedback/measurement-roles';
const PROGRAM_ID = /^evolution-program:[a-f0-9]{32}$/;

function isValidSourceMessageId(value: string): boolean {
  return value.length <= 240 && value.trim().length > 0 && value === value.trim() && !/[\r\n]/.test(value);
}

export const CAPABILITY_EVOLUTION_MEASUREMENT_BLOCKERS = [
  'measurement_birth_contract_missing',
  'measurement_roles_missing',
  'evaluation_cohort_missing',
  'evidence_role_proof_missing',
  'consumer_consumption_receipt_missing',
  'optimizer_exposure_proof_missing',
  'independent_promotion_holdout_missing',
] as const;

type CapabilityEvolutionMeasurementBlocker = (typeof CAPABILITY_EVOLUTION_MEASUREMENT_BLOCKERS)[number];

export type CapabilityEvolutionMeasurementIssuance =
  | {
      status: 'insufficient';
      reason:
        | 'invalid_program_id'
        | 'program_not_found'
        | 'program_owner_mismatch'
        | 'program_not_active'
        | 'not_domain_eval_cat'
        | 'source_owner_manifest_missing'
        | 'source_owner_manifest_invalid'
        | 'source_owner_revision_invalid'
        | 'source_owner_store_unavailable'
        | 'idempotency_collision'
        | 'publication_failed';
      sourceRef?: OwnerTruthRefV1;
      blockers: CapabilityEvolutionMeasurementBlocker[];
      detail?: string;
    }
  | {
      status: 'published';
      sourceRef: OwnerTruthRefV1;
      certificateRef: OwnerTruthRefV1;
      measurementRoleRefs: Record<CapabilityEvolutionMeasurementRoleName, OwnerTruthRefV1>;
      resultRef: OwnerTruthRefV1;
      evidenceProofRef: OwnerTruthRefV1;
      measurementDecisionStatus: 'usable' | 'insufficient';
      proofStatus: 'verified' | 'insufficient';
      commitSha: string;
      prUrl: string;
    };

type InsufficientCapabilityEvolutionMeasurementIssuance = Extract<
  CapabilityEvolutionMeasurementIssuance,
  { status: 'insufficient' }
>;

export interface CapabilityEvolutionMeasurementIssuer {
  issue(input: CapabilityEvolutionMeasurementIssueInput): Promise<CapabilityEvolutionMeasurementIssuance>;
}

export interface CapabilityEvolutionMeasurementIssueInput {
  programId: string;
  ownerUserId: string;
  catId: string;
  clientMessageId: string;
}

interface ProgramReader {
  get(programId: string): Promise<EvolutionProgramProjectionV1>;
}

export interface CapabilityEvolutionMeasurementIssuerOptions {
  repoRoot: string;
  programReader: ProgramReader;
  gitPublisher: GitPublisher;
  sourceStore?: CapabilityEvolutionMeasurementSourceStore;
  evalCatId?: string;
}

function insufficient(
  reason: InsufficientCapabilityEvolutionMeasurementIssuance['reason'],
  sourceRef?: OwnerTruthRefV1,
  detail?: string,
): InsufficientCapabilityEvolutionMeasurementIssuance {
  return {
    status: 'insufficient',
    reason,
    ...(sourceRef ? { sourceRef } : {}),
    blockers: [...CAPABILITY_EVOLUTION_MEASUREMENT_BLOCKERS],
    ...(detail ? { detail } : {}),
  };
}

interface PreparedMeasurementSource {
  status: 'prepared';
  sourceRef: OwnerTruthRefV1;
  artifactRef: string;
  sourceSha256: string;
  manifestRevision: string;
  manifest: CapabilityEvolutionMeasurementSource;
  evidenceProofRef: OwnerTruthRefV1;
  proofRef: string;
  roles: ReturnType<typeof buildCapabilityEvolutionMeasurementRoleArtifacts>;
}

async function prepareMeasurementSource(
  options: CapabilityEvolutionMeasurementIssuerOptions,
  sourceStore: CapabilityEvolutionMeasurementSourceStore,
  input: CapabilityEvolutionMeasurementIssueInput,
): Promise<PreparedMeasurementSource | InsufficientCapabilityEvolutionMeasurementIssuance> {
  let projection: EvolutionProgramProjectionV1;
  try {
    projection = await options.programReader.get(input.programId);
  } catch {
    return insufficient('program_not_found');
  }
  const sourceRef = capabilityEvolutionMeasurementSourceRef(projection);
  if (projection.program.workspaceId !== `user:${input.ownerUserId}`) {
    return insufficient('program_owner_mismatch', sourceRef);
  }
  if (projection.program.lifecycle !== 'active') return insufficient('program_not_active', sourceRef);

  const artifactRef = capabilityEvolutionMeasurementSourceArtifactRef(input.programId);
  const source = await sourceStore.readOnMain(artifactRef);
  if (source.status !== 'ok') {
    return insufficient(
      source.status === 'missing'
        ? 'source_owner_manifest_missing'
        : source.status === 'unavailable'
          ? 'source_owner_store_unavailable'
          : 'source_owner_manifest_invalid',
      sourceRef,
      source.detail,
    );
  }

  try {
    const rawManifest = parse(source.bytes.toString('utf8'));
    CapabilityEvolutionMeasurementSourceSchema.parse(rawManifest);
    // Preserve mapping order: nested certificate/result hashes name the source owner's exact YAML bytes.
    const manifest = rawManifest as CapabilityEvolutionMeasurementSource;
    validateCapabilityEvolutionMeasurementSource({
      manifest,
      projection,
      ownerUserId: input.ownerUserId,
    });
    const revision = await sourceStore.verifySourceRevision({
      manifest,
      manifestRevision: source.manifestRevision,
    });
    if (revision.status !== 'verified') {
      return insufficient(
        revision.status === 'unavailable' ? 'source_owner_store_unavailable' : 'source_owner_revision_invalid',
        sourceRef,
        revision.detail,
      );
    }
    const sourceSha256 = digest(source.bytes);
    const proofRef = `measurement-proof:${manifest.decisionProof.proofId}`;
    return {
      status: 'prepared',
      sourceRef,
      artifactRef,
      sourceSha256,
      manifestRevision: source.manifestRevision,
      manifest,
      proofRef,
      evidenceProofRef: { ownerFeatureId: 'F267', ownerStateRef: proofRef },
      roles: buildCapabilityEvolutionMeasurementRoleArtifacts({
        manifest,
        sourceRef,
        sourceArtifactRef: artifactRef,
        sourceSha256,
      }),
    };
  } catch (error) {
    return insufficient(
      'source_owner_manifest_invalid',
      sourceRef,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function publishPreparedMeasurement(
  options: CapabilityEvolutionMeasurementIssuerOptions,
  input: CapabilityEvolutionMeasurementIssueInput,
  prepared: PreparedMeasurementSource,
): Promise<CapabilityEvolutionMeasurementIssuance> {
  const { artifactRef, evidenceProofRef, manifest, manifestRevision, proofRef, roles, sourceRef, sourceSha256 } =
    prepared;
  const branchName = `measurement/auto/capability-evolution/${manifest.decisionProof.proofId}`;
  let proofStatus: 'verified' | 'insufficient' | undefined;
  try {
    const replay = await resolveCapabilityEvolutionMeasurementPublication({
      gitPublisher: options.gitPublisher,
      branchName,
      sourceMessageId: input.clientMessageId,
      ownerUserId: input.ownerUserId,
      sourceRef,
      artifactRef,
      sourceSha256,
      manifest,
      evidenceProofRef,
      roles,
    });
    if (replay) {
      return { status: 'published', ...capabilityEvolutionMeasurementPublicationFields({ ...prepared, ...replay }) };
    }

    const published = await options.gitPublisher.publishOnIsolatedWorktree({
      branchName,
      sourceBase: manifestRevision,
      async stage(worktreeRoot) {
        const isolatedSource = await readContainedFile(
          worktreeRoot,
          artifactRef,
          CAPABILITY_EVOLUTION_MEASUREMENT_SOURCE_ROOT,
        );
        if (isolatedSource.status !== 'ok' || digest(isolatedSource.bytes) !== sourceSha256) {
          throw new Error('source owner manifest is not immutable on origin/main');
        }
        const paths = await Promise.all([
          persistImmutableMeasurementArtifact(
            worktreeRoot,
            manifest.decisionProof.subject.certificateRef,
            manifest.certificate,
          ),
          persistImmutableMeasurementArtifact(worktreeRoot, manifest.decisionProof.subject.resultRef, manifest.result),
          ...manifest.ownerObjects.map((entry) =>
            persistImmutableMeasurementArtifact(worktreeRoot, entry.ref, entry.artifact),
          ),
          ...roles.map((role) =>
            persistImmutableMeasurementArtifact(
              worktreeRoot,
              `${ROLE_ROOT}/${manifest.decisionProof.proofId}/${role.persistedName}.yaml`,
              role.artifact,
            ),
          ),
          persistImmutableMeasurementArtifact(
            worktreeRoot,
            `${PROOF_RECORD_ROOT}/${manifest.decisionProof.proofId}.yaml`,
            MeasurementDecisionProofRecordSchema.parse({
              kind: 'f267-measurement-decision-proof-record',
              schemaVersion: 1,
              proofRef,
              ownerUserId: input.ownerUserId,
              sourceAttestations: [{ ...sourceRef, artifactRef, sha256: sourceSha256, manifestRevision }],
              candidate: manifest.decisionProof,
            }),
          ),
        ]);
        const resolution = await createFileMeasurementDecisionProofResolver({ repoRoot: worktreeRoot }).resolve({
          ownerUserId: input.ownerUserId,
          evidenceProofRef,
        });
        if (resolution.status !== 'resolved') throw new Error(`issued proof did not resolve: ${resolution.reason}`);
        proofStatus = resolution.proof.status;
        if (manifest.result.decision.status === 'usable' && proofStatus !== 'verified') {
          throw new Error('usable measurement requires a fully verified owner proof');
        }
        return {
          paths,
          commitMessage: `eval(F267): issue ${manifest.decisionProof.proofId}\n\nWhy: bind capability-evolution measurement to canonical source-owner evidence without advancing F311.\n\nSource-Message: ${input.clientMessageId}`,
          prTitle: `eval(F267): issue ${manifest.decisionProof.proofId}`,
          prBody: `F267 owner-issued capability-evolution measurement artifacts.\n\nProgram: ${input.programId}\nSource: ${sourceRef.ownerFeatureId}/${sourceRef.ownerStateRef}\nDecision: ${manifest.result.decision.status}\n\nThis PR does not mutate or advance the F311 Program.`,
        };
      },
    });
    if (!proofStatus) throw new Error('publisher completed without resolving the issued proof');
    return {
      status: 'published',
      ...capabilityEvolutionMeasurementPublicationFields({ ...prepared, ...published, proofStatus }),
    };
  } catch (error) {
    return insufficient('publication_failed', sourceRef, error instanceof Error ? error.message : String(error));
  }
}

export function createCapabilityEvolutionMeasurementIssuer(
  options: CapabilityEvolutionMeasurementIssuerOptions,
): CapabilityEvolutionMeasurementIssuer {
  const sourceStore =
    options.sourceStore ?? createGitCapabilityEvolutionMeasurementSourceStore({ repoRoot: options.repoRoot });
  const issue = createBoundedIdempotentRunner({
    run: async (input: CapabilityEvolutionMeasurementIssueInput) => {
      const prepared = await prepareMeasurementSource(options, sourceStore, input);
      return prepared.status === 'insufficient' ? prepared : publishPreparedMeasurement(options, input, prepared);
    },
    fingerprint: (input) => JSON.stringify([input.programId, input.ownerUserId, input.catId]),
    collision: () => insufficient('idempotency_collision'),
    shouldCache: (result) => result.status === 'published',
  });
  return {
    async issue(input) {
      if (!isValidSourceMessageId(input.clientMessageId)) return insufficient('idempotency_collision');
      if (!PROGRAM_ID.test(input.programId)) return insufficient('invalid_program_id');
      if (input.catId !== (options.evalCatId ?? 'codex-sol')) return insufficient('not_domain_eval_cat');
      return issue(input);
    },
  };
}
