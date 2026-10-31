import { z } from 'zod';
import {
  addRoutingDuplicateIssues,
  ROUTING_CONTEXT_VERSION,
  routingEpochMsSchema,
  routingIdentifierSchema,
  routingOwnerIdSchema,
  routingReferenceSchema,
  routingSummarySchema,
} from './routing-context-common.js';
import {
  routingCandidateBindingV1Schema,
  routingPreferenceRevisionV1Schema,
  routingSignalEventV1Schema,
  routingSubjectRefV1Schema,
} from './routing-context-inputs.js';
import { routingContextSnapshotV1Schema } from './routing-context-projections.js';

const routingCommandShape = {
  v: z.literal(ROUTING_CONTEXT_VERSION),
  commandId: routingIdentifierSchema,
};

export const routingSignalMarkCommandV1Schema = z
  .object({
    ...routingCommandShape,
    subjectRef: routingSubjectRefV1Schema,
    state: z.enum(['scarce', 'degraded', 'unavailable']),
    reasonCode: routingIdentifierSchema,
    note: routingSummarySchema.optional(),
    validUntil: routingEpochMsSchema.optional(),
    resetAt: routingEpochMsSchema.optional(),
  })
  .strict()
  .superRefine((command, ctx) => {
    if (command.validUntil === undefined && command.resetAt === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validUntil'],
        message: 'a manual routing signal requires validUntil or resetAt',
      });
    }
  });

export const routingSignalCloseCommandV1Schema = z
  .object({
    ...routingCommandShape,
    reasonCode: routingIdentifierSchema,
    note: routingSummarySchema.optional(),
  })
  .strict();

const routingPreferenceRuleShape = {
  appliesWhen: z
    .object({
      intent: z.enum(['review', 'architecture']).optional(),
      requireEligible: z.array(routingSubjectRefV1Schema).min(1).max(32).optional(),
    })
    .strict(),
  prefer: z.array(routingSubjectRefV1Schema).min(1).max(32),
  over: z.array(routingSubjectRefV1Schema).min(1).max(32),
  rationale: routingSummarySchema,
  evidenceRefs: z.array(routingReferenceSchema).min(1).max(32),
  reviewAfter: routingEpochMsSchema.optional(),
};

function routingSubjectKey(subject: z.infer<typeof routingSubjectRefV1Schema>): string {
  if (subject.type === 'cat') return `cat:${subject.catId}`;
  if (subject.type === 'provider') return `provider:${subject.providerId}`;
  return `quota_pool:${subject.poolId}`;
}

function addPreferenceRuleIssues(
  rule: { prefer: z.infer<typeof routingSubjectRefV1Schema>[]; over: z.infer<typeof routingSubjectRefV1Schema>[] },
  ctx: z.RefinementCtx,
): void {
  const preferKeys = rule.prefer.map(routingSubjectKey);
  const overKeys = rule.over.map(routingSubjectKey);
  addRoutingDuplicateIssues(preferKeys, ['prefer'], ctx);
  addRoutingDuplicateIssues(overKeys, ['over'], ctx);
  const preferred = new Set(preferKeys);
  overKeys.forEach((key, index) => {
    if (preferred.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['over', index],
        message: 'the same subject cannot appear on both sides of a preference',
      });
    }
  });
}

export const routingPreferenceCreateCommandV1Schema = z
  .object({
    ...routingCommandShape,
    ...routingPreferenceRuleShape,
  })
  .strict()
  .superRefine(addPreferenceRuleIssues);

export const routingPreferenceSupersedeCommandV1Schema = z
  .object({
    ...routingCommandShape,
    baseRevisionId: routingIdentifierSchema,
    baseVersion: z.number().int().positive(),
    ...routingPreferenceRuleShape,
  })
  .strict()
  .superRefine(addPreferenceRuleIssues);

export const routingPreferenceRetireCommandV1Schema = z
  .object({
    ...routingCommandShape,
    baseRevisionId: routingIdentifierSchema,
    baseVersion: z.number().int().positive(),
    retirementReason: routingSummarySchema,
  })
  .strict();

const routingContextSourceRefsV1Schema = z
  .object({
    signalEventIds: z.array(routingIdentifierSchema).max(10_000),
    preferenceRevisionIds: z.array(routingIdentifierSchema).max(10_000),
    dossierRevisions: z.array(routingReferenceSchema).max(256),
  })
  .strict();

const routingContextFreshResolutionV1Schema = z
  .object({
    state: z.literal('fresh'),
    snapshot: routingContextSnapshotV1Schema,
    inputRevisionRef: routingReferenceSchema,
    sourceRefs: routingContextSourceRefsV1Schema,
  })
  .strict();

const routingContextDegradedResolutionV1Schema = z
  .object({
    state: z.literal('degraded'),
    reason: z.enum([
      'dossier_unavailable',
      'dossier_unreadable_or_empty',
      'built_in_profile_missing',
      'model_missing',
      'routing_store_unavailable',
      'routing_store_error',
    ]),
    affectedCatIds: z.array(routingOwnerIdSchema).max(64),
    candidateBindings: z.array(routingCandidateBindingV1Schema).max(64),
  })
  .strict();

export const routingContextReadModelV1Schema = z
  .object({
    v: z.literal(ROUTING_CONTEXT_VERSION),
    ownerId: routingOwnerIdSchema,
    observedAt: routingEpochMsSchema,
    catalogRevision: routingReferenceSchema,
    resolution: z.discriminatedUnion('state', [
      routingContextFreshResolutionV1Schema,
      routingContextDegradedResolutionV1Schema,
    ]),
    signalEvents: z.array(routingSignalEventV1Schema).max(10_000),
    preferenceRevisions: z.array(routingPreferenceRevisionV1Schema).max(10_000),
  })
  .strict()
  .superRefine((model, ctx) => {
    if (model.resolution.state === 'degraded') {
      addRoutingDuplicateIssues(
        model.resolution.candidateBindings.map((candidate) => candidate.catId),
        ['resolution', 'candidateBindings'],
        ctx,
      );
    }
    if (model.resolution.state === 'fresh') {
      if (model.resolution.snapshot.ownerId !== model.ownerId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['resolution', 'snapshot', 'ownerId'],
          message: 'the snapshot owner must match the read-model owner',
        });
      }
      if (model.resolution.snapshot.observedAt !== model.observedAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['resolution', 'snapshot', 'observedAt'],
          message: 'the snapshot time must match the read-model time',
        });
      }
      if (model.resolution.snapshot.catalogRevision !== model.catalogRevision) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['resolution', 'snapshot', 'catalogRevision'],
          message: 'the snapshot catalog revision must match the read model',
        });
      }
    }
    model.signalEvents.forEach((event, index) => {
      if (event.ownerId !== model.ownerId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['signalEvents', index, 'ownerId'],
          message: 'signal events must belong to the read-model owner',
        });
      }
    });
    model.preferenceRevisions.forEach((revision, index) => {
      if (revision.ownerId !== model.ownerId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['preferenceRevisions', index, 'ownerId'],
          message: 'preference revisions must belong to the read-model owner',
        });
      }
    });
  });

export type RoutingSignalMarkCommandV1 = z.infer<typeof routingSignalMarkCommandV1Schema>;
export type RoutingSignalCloseCommandV1 = z.infer<typeof routingSignalCloseCommandV1Schema>;
export type RoutingPreferenceCreateCommandV1 = z.infer<typeof routingPreferenceCreateCommandV1Schema>;
export type RoutingPreferenceSupersedeCommandV1 = z.infer<typeof routingPreferenceSupersedeCommandV1Schema>;
export type RoutingPreferenceRetireCommandV1 = z.infer<typeof routingPreferenceRetireCommandV1Schema>;
export type RoutingContextReadModelV1 = z.infer<typeof routingContextReadModelV1Schema>;
