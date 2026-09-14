import { z } from 'zod';

export const APPROVAL_LIFECYCLE_VERSION = 1 as const;

export const approvalResolutionSchema = z.enum(['open', 'accepted', 'skipped', 'rejected', 'closed_without_decision']);
export type ApprovalResolution = z.infer<typeof approvalResolutionSchema>;

export const approvalMaterializationSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_started') }).strict(),
  z.object({ state: z.literal('outcome_unknown') }).strict(),
  z.object({ state: z.literal('in_progress'), attemptRef: z.string().trim().min(1) }).strict(),
  z.object({ state: z.literal('succeeded'), effectProofRef: z.string().trim().min(1) }).strict(),
  z
    .object({
      state: z.literal('failed'),
      failureRef: z.string().trim().min(1),
      retryable: z.boolean(),
    })
    .strict(),
]);
export type ApprovalMaterialization = z.infer<typeof approvalMaterializationSchema>;

export const approvalLifecycleProjectionSchema = z
  .object({
    resolution: approvalResolutionSchema,
    materialization: approvalMaterializationSchema,
  })
  .strict()
  .superRefine((projection, ctx) => {
    if (projection.resolution !== 'accepted' && projection.materialization.state !== 'not_started') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['materialization'],
        message: 'only accepted Approval may have materialization state',
      });
    }
  });
export type ApprovalLifecycleProjection = z.infer<typeof approvalLifecycleProjectionSchema>;

export type LegacyApprovalStatus =
  | 'pending'
  | 'approving'
  | 'applying'
  | 'approved'
  | 'accepted'
  | 'skipped'
  | 'rejected'
  | 'withdrawn'
  | 'superseded'
  | 'stale'
  | 'expired'
  | 'closed_without_decision';

export interface LegacyApprovalLifecycleInput {
  status: LegacyApprovalStatus;
  canonicalEffectProofRef?: string;
}

/**
 * The single adapter-boundary normalizer for pre-v1 producer vocabulary.
 * A legacy "approved" row is a decision fact, never proof that its dependent
 * operation completed. Only an owner-backed canonical receipt may upgrade it.
 */
export function normalizeApprovalLifecycleProjection(input: LegacyApprovalLifecycleInput): ApprovalLifecycleProjection {
  let projection: ApprovalLifecycleProjection;
  switch (input.status) {
    case 'pending':
      projection = { resolution: 'open', materialization: { state: 'not_started' } };
      break;
    case 'approving':
    case 'applying':
    case 'approved':
    case 'accepted':
      projection = input.canonicalEffectProofRef
        ? {
            resolution: 'accepted',
            materialization: { state: 'succeeded', effectProofRef: input.canonicalEffectProofRef },
          }
        : { resolution: 'accepted', materialization: { state: 'outcome_unknown' } };
      break;
    case 'rejected':
      projection = { resolution: 'rejected', materialization: { state: 'not_started' } };
      break;
    case 'skipped':
      projection = { resolution: 'skipped', materialization: { state: 'not_started' } };
      break;
    case 'withdrawn':
    case 'superseded':
    case 'stale':
    case 'expired':
    case 'closed_without_decision':
      projection = { resolution: 'closed_without_decision', materialization: { state: 'not_started' } };
      break;
    default:
      throw new Error(`unknown legacy Approval status: ${String(input.status)}`);
  }
  return approvalLifecycleProjectionSchema.parse(projection);
}

export const approvalLifecycleEpochPhaseSchema = z.enum(['legacy_active', 'draining', 'fenced', 'v1_active']);
export type ApprovalLifecycleEpochPhase = z.infer<typeof approvalLifecycleEpochPhaseSchema>;

export const approvalLifecycleEpochRecordSchema = z
  .object({
    producerId: z.string().regex(/^F\d{3}$/),
    epoch: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    phase: approvalLifecycleEpochPhaseSchema,
    updatedAt: z.string().datetime({ offset: true }),
    cutoverReceiptRef: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if ((record.phase === 'v1_active') !== (record.cutoverReceiptRef !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cutoverReceiptRef'],
        message: 'cutoverReceiptRef is required exactly for v1_active',
      });
    }
  });
export type ApprovalLifecycleEpochRecord = z.infer<typeof approvalLifecycleEpochRecordSchema>;

export type ApprovalWriterGeneration = 'legacy' | 'v1';
export type ApprovalLifecycleOperation = 'proposal_ingress' | 'decision' | 'materialization' | 'recovery_lease';

export interface ApprovalLifecycleQuiescence {
  activeDecisionCommands: number;
  materializationAttempts: number;
  recoveryLeases: number;
}

export function assertApprovalLifecycleTransition(
  from: ApprovalLifecycleEpochRecord,
  to: ApprovalLifecycleEpochPhase,
  quiescence?: ApprovalLifecycleQuiescence,
): void {
  const next: Record<ApprovalLifecycleEpochPhase, ApprovalLifecycleEpochPhase | undefined> = {
    legacy_active: 'draining',
    draining: 'fenced',
    fenced: 'v1_active',
    v1_active: undefined,
  };
  if (next[from.phase] !== to) throw new Error(`illegal Approval lifecycle transition ${from.phase} -> ${to}`);
  if (to !== 'v1_active') return;
  if (!quiescence) throw new Error('v1 activation requires a quiescence snapshot after fencing');
  const counts = Object.values(quiescence);
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error('quiescence counts must be non-negative safe integers');
  }
  if (counts.some((count) => count !== 0)) throw new Error('quiescence is not reached');
}

export function approvalLifecycleOperationAllowed(
  record: ApprovalLifecycleEpochRecord,
  writer: ApprovalWriterGeneration,
  operation: ApprovalLifecycleOperation,
): boolean {
  if (record.phase === 'legacy_active') return writer === 'legacy';
  if (record.phase === 'draining') {
    return (
      writer === 'legacy' &&
      (operation === 'decision' || operation === 'materialization' || operation === 'recovery_lease')
    );
  }
  if (record.phase === 'fenced') return false;
  return writer === 'v1';
}
