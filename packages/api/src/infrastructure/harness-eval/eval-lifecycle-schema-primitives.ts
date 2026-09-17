import { exactAssetVersionRefV1Schema, ownerTruthRefV1Schema } from '@cat-cafe/shared';
import { z } from 'zod';

export const nonEmptyString = z.string().trim().min(1);
export const isoDateTime = z.string().datetime({ offset: true });

const lifecycleRefKindSchema = z.enum([
  'verdict',
  'message',
  'task',
  'plan',
  'commit',
  'pull_request',
  'reeval',
  'sla',
  'other',
]);

export const EvalLifecycleRefSchema = z.discriminatedUnion('availability', [
  z.object({ kind: lifecycleRefKindSchema, availability: z.literal('available'), value: nonEmptyString }).strict(),
  z
    .object({
      kind: lifecycleRefKindSchema,
      availability: z.literal('unavailable'),
      unavailableReason: nonEmptyString,
    })
    .strict(),
]);

export type EvalLifecycleRef = z.infer<typeof EvalLifecycleRefSchema>;

export const EvalLifecycleActorSchema = z
  .object({
    kind: z.enum(['cat', 'cvo', 'automation', 'migration']),
    id: nonEmptyString,
  })
  .strict();

export type EvalLifecycleActor = z.infer<typeof EvalLifecycleActorSchema>;

export const eventBaseSchema = z
  .object({
    eventId: nonEmptyString,
    caseId: nonEmptyString.optional(),
    verdictId: nonEmptyString,
    domainId: nonEmptyString,
    actor: EvalLifecycleActorSchema,
    occurredAt: isoDateTime,
    reason: nonEmptyString,
    refs: z.array(EvalLifecycleRefSchema).min(1),
  })
  .strict();

export const approvalRequestSnapshotSchema = z
  .object({
    ownerRef: ownerTruthRefV1Schema,
    ownerAuthorizationRef: ownerTruthRefV1Schema,
    targetVersionRef: exactAssetVersionRefV1Schema,
    dispatchRef: ownerTruthRefV1Schema,
  })
  .strict();

export const approvalRequestOriginSchema = z
  .object({
    invocationId: nonEmptyString,
    threadId: nonEmptyString,
    messageId: nonEmptyString,
    requesterCatId: nonEmptyString,
    ownerUserId: nonEmptyString,
  })
  .strict();

export const evalRepairOwnerLineageSchema = z
  .object({
    programRef: ownerTruthRefV1Schema,
    cycleRef: ownerTruthRefV1Schema,
    interventionRef: ownerTruthRefV1Schema,
  })
  .strict();
