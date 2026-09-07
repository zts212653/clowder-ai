import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  exactAssetVersionRefV1Schema,
  type OwnerTruthRefV1,
  ownerTruthRefV1Schema,
  refIdentity,
} from '@cat-cafe/shared';
import { parse } from 'yaml';
import { z } from 'zod';

const PROGRAM_ID = 'evolution-program:bcc336788a7df9d6075b1efb4c0a7e68';
const OWNER_INPUT_ROOT = 'docs/harness-feedback/measurement-sources/capability-evolution/owner-inputs';
const PREFIX = 'evolution-program-bcc336788a7df9d6075b1efb4c0a7e68';
const MEASUREMENT_SOURCE_PATH =
  'docs/harness-feedback/measurement-sources/capability-evolution/evolution-program-bcc336788a7df9d6075b1efb4c0a7e68.yaml';
export const F311_E0_EVAL_REPAIR_OWNER_BINDING_PATH =
  `${OWNER_INPUT_ROOT}/${PREFIX}-eval-repair-owner-binding-v1.yaml` as const;

const sourceRefSchema = z
  .string()
  .trim()
  .regex(/^thread_[^#\s]+#[^#\s]+$/);
const targetSchema = ownerTruthRefV1Schema;
const bindingSchema = z
  .object({
    kind: z.literal('f311-eval-repair-owner-binding'),
    schemaVersion: z.literal(1),
    measurementSourceRef: z.literal(MEASUREMENT_SOURCE_PATH),
    programRef: ownerTruthRefV1Schema,
    targetRef: targetSchema,
    targetVersionRef: exactAssetVersionRefV1Schema,
    valueOwnerRef: ownerTruthRefV1Schema,
    domainOwnerRef: ownerTruthRefV1Schema,
    ownerAuthorization: z
      .object({
        status: z.literal('missing'),
        blockerRef: ownerTruthRefV1Schema,
        sourceRefs: z.array(sourceRefSchema).min(1),
      })
      .strict(),
    lineageBindings: z
      .array(
        z
          .object({
            programRef: ownerTruthRefV1Schema,
            cycleRef: ownerTruthRefV1Schema,
            interventionRef: ownerTruthRefV1Schema,
            caseActionRef: z
              .string()
              .trim()
              .regex(/^case-action:f266:[^\s]+$/),
          })
          .strict(),
      )
      .max(0),
    interventionReceipts: z.array(z.never()).max(0),
    freshOutcomeReceipts: z.array(z.never()).max(0),
    decisionReceipts: z.array(z.never()).max(0),
    truthBoundary: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

const charterSchema = z
  .object({
    kind: z.literal('f311-evolution-program-owner-charter'),
    schemaVersion: z.literal(1),
    programId: z.literal(PROGRAM_ID),
    targetRef: targetSchema,
    valueOwnerRef: ownerTruthRefV1Schema,
    economicCertificateRef: ownerTruthRefV1Schema,
  })
  .passthrough();

const economicSchema = z
  .object({
    kind: z.literal('f311-evolution-economic-certificate'),
    schemaVersion: z.literal(1),
    programId: z.literal(PROGRAM_ID),
    certificateRef: ownerTruthRefV1Schema,
    targetRef: targetSchema,
    valueOwnerRef: ownerTruthRefV1Schema,
    authorizationRefs: z.array(sourceRefSchema).min(1),
    notAuthorized: z.array(z.string().trim().min(1)).min(1),
  })
  .passthrough();

const roleAssignmentSchema = z
  .object({
    kind: z.literal('f311-capability-evolution-measurement-role-assignment'),
    schemaVersion: z.literal(1),
    programId: z.literal(PROGRAM_ID),
    targetRef: targetSchema,
    roles: z.object({ domainOwner: ownerTruthRefV1Schema }).passthrough(),
  })
  .passthrough();

const measurementSourceSchema = z
  .object({
    kind: z.literal('f267-capability-evolution-measurement-source'),
    schemaVersion: z.literal(1),
    ownerUserId: z.string().trim().min(1),
    ownerFeatureId: z.literal('F311'),
    sourceArtifacts: z.array(z.object({ ref: z.string().trim().min(1) }).passthrough()).min(1),
    program: z.object({ targetRef: targetSchema }).passthrough(),
    roles: z.object({ consumer: ownerTruthRefV1Schema, domainOwner: ownerTruthRefV1Schema }).passthrough(),
    result: z
      .object({
        decision: z.object({ status: z.literal('insufficient') }).passthrough(),
        actionProposal: z.object({ action: z.literal('keep_observe') }).passthrough(),
      })
      .passthrough(),
    ownerObjects: z.array(z.never()).max(0),
  })
  .passthrough();

export type F311E0EvalRepairOwnerBinding = z.infer<typeof bindingSchema>;

function sameRef(left: OwnerTruthRefV1, right: OwnerTruthRefV1): boolean {
  return refIdentity(left) === refIdentity(right);
}

function sameOwnerAddress(left: OwnerTruthRefV1, right: OwnerTruthRefV1): boolean {
  return left.ownerFeatureId === right.ownerFeatureId && left.ownerStateRef === right.ownerStateRef;
}

async function readYaml(repoRoot: string, relativePath: string): Promise<unknown> {
  return parse(await readFile(resolve(repoRoot, relativePath), 'utf8')) as unknown;
}

export async function loadF311E0EvalRepairOwnerBinding(repoRoot: string): Promise<F311E0EvalRepairOwnerBinding> {
  const [binding, charter, economic, roles, measurement] = await Promise.all([
    readYaml(repoRoot, F311_E0_EVAL_REPAIR_OWNER_BINDING_PATH).then((value) => bindingSchema.parse(value)),
    readYaml(repoRoot, `${OWNER_INPUT_ROOT}/${PREFIX}-charter-v1.yaml`).then((value) => charterSchema.parse(value)),
    readYaml(repoRoot, `${OWNER_INPUT_ROOT}/${PREFIX}-economic-certificate-v1.yaml`).then((value) =>
      economicSchema.parse(value),
    ),
    readYaml(repoRoot, `${OWNER_INPUT_ROOT}/${PREFIX}-measurement-role-assignment-v1.yaml`).then((value) =>
      roleAssignmentSchema.parse(value),
    ),
    readYaml(repoRoot, MEASUREMENT_SOURCE_PATH).then((value) => measurementSourceSchema.parse(value)),
  ]);
  const requiredArtifacts = [
    `${OWNER_INPUT_ROOT}/${PREFIX}-charter-v1.yaml`,
    `${OWNER_INPUT_ROOT}/${PREFIX}-economic-certificate-v1.yaml`,
    `${OWNER_INPUT_ROOT}/${PREFIX}-measurement-role-assignment-v1.yaml`,
  ];
  if (
    binding.programRef.ownerFeatureId !== 'F311' ||
    binding.programRef.ownerStateRef !== PROGRAM_ID ||
    !sameRef(binding.targetRef, charter.targetRef) ||
    !sameRef(binding.targetRef, economic.targetRef) ||
    !sameRef(binding.targetRef, roles.targetRef) ||
    !sameRef(binding.targetRef, measurement.program.targetRef) ||
    !sameRef(binding.valueOwnerRef, charter.valueOwnerRef) ||
    !sameRef(binding.valueOwnerRef, economic.valueOwnerRef) ||
    !sameRef(binding.valueOwnerRef, measurement.roles.consumer) ||
    !sameRef(binding.domainOwnerRef, roles.roles.domainOwner) ||
    !sameRef(binding.domainOwnerRef, measurement.roles.domainOwner) ||
    !sameRef(binding.ownerAuthorization.blockerRef, charter.economicCertificateRef) ||
    !sameRef(binding.ownerAuthorization.blockerRef, economic.certificateRef) ||
    binding.ownerAuthorization.sourceRefs.some((sourceRef) => !economic.authorizationRefs.includes(sourceRef)) ||
    !economic.notAuthorized.some((statement) => /owner authorization/i.test(statement)) ||
    measurement.ownerUserId !== binding.valueOwnerRef.ownerStateRef.replace(/^user:/, '') ||
    requiredArtifacts.some((ref) => !measurement.sourceArtifacts.some((artifact) => artifact.ref === ref))
  ) {
    throw new Error('F311 E0 eval-repair owner binding diverges from canonical owner inputs');
  }
  if (
    !sameOwnerAddress(binding.targetRef, binding.targetVersionRef) ||
    binding.targetVersionRef.assetKind !== 'capability' ||
    binding.targetVersionRef.assetId !== 'f311-investor-roadshow-expression'
  ) {
    throw new Error('F311 E0 eval-repair target version does not name the canonical capability');
  }
  return binding;
}
