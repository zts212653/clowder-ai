import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);
const isoDateTime = z.string().datetime({ offset: true });

export const EvalVerdictLifecycleStatusSchema = z.enum([
  'open',
  'acknowledged',
  'action_planned',
  'fix_landed',
  'main_landed',
  'live_active',
  'reeval_pending',
  'resolved',
  'suppressed_with_reason',
  'escalated',
]);

export type EvalVerdictLifecycleStatus = z.infer<typeof EvalVerdictLifecycleStatusSchema>;

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

const availableLifecycleRefSchema = z
  .object({
    kind: lifecycleRefKindSchema,
    availability: z.literal('available'),
    value: nonEmptyString,
  })
  .strict();

const unavailableLifecycleRefSchema = z
  .object({
    kind: lifecycleRefKindSchema,
    availability: z.literal('unavailable'),
    unavailableReason: nonEmptyString,
  })
  .strict();

export const EvalLifecycleRefSchema = z.discriminatedUnion('availability', [
  availableLifecycleRefSchema,
  unavailableLifecycleRefSchema,
]);

export type EvalLifecycleRef = z.infer<typeof EvalLifecycleRefSchema>;

export const EvalLifecycleActorSchema = z
  .object({
    kind: z.enum(['cat', 'cvo', 'automation', 'migration']),
    id: nonEmptyString,
  })
  .strict();

export type EvalLifecycleActor = z.infer<typeof EvalLifecycleActorSchema>;

const eventBaseSchema = z
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

const plainEvent = <T extends string>(type: T) => eventBaseSchema.extend({ type: z.literal(type) }).strict();

export const EvalLifecycleEventSchema = z.discriminatedUnion('type', [
  plainEvent('verdict_opened'),
  eventBaseSchema
    .extend({
      type: z.literal('verdict_cycle_observed'),
      caseId: nonEmptyString,
      cycleCreatedAt: isoDateTime,
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('responsibility_bound'),
      caseId: nonEmptyString,
      taskId: nonEmptyString,
      leaseId: nonEmptyString,
      leaseGeneration: z.number().int().positive(),
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('owner_reassigned'),
      targetOwnerCatId: nonEmptyString,
    })
    .strict(),
  plainEvent('owner_acknowledged'),
  plainEvent('action_planned'),
  plainEvent('fix_recorded'),
  eventBaseSchema
    .extend({ type: z.literal('main_landed'), caseId: nonEmptyString, commitSha: z.string().regex(/^[a-f0-9]{7,64}$/) })
    .strict(),
  eventBaseSchema
    .extend({ type: z.literal('live_active'), caseId: nonEmptyString, commitSha: z.string().regex(/^[a-f0-9]{7,64}$/) })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('reeval_requested'),
      dueAt: isoDateTime,
      assignedEvalCatId: nonEmptyString.optional(),
    })
    .strict(),
  eventBaseSchema.extend({ type: z.literal('reeval_passed'), assignedEvalCatId: nonEmptyString }).strict(),
  eventBaseSchema.extend({ type: z.literal('reeval_failed'), assignedEvalCatId: nonEmptyString }).strict(),
  plainEvent('cvo_suppressed'),
  eventBaseSchema
    .extend({
      type: z.literal('sla_escalated'),
      stage: z.enum(['acknowledgement', 'reevaluation']),
      dueAt: isoDateTime,
    })
    .strict(),
]);

export type EvalLifecycleEvent = z.infer<typeof EvalLifecycleEventSchema>;
