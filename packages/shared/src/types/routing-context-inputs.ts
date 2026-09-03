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

export const routingSubjectRefV1Schema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cat'), catId: routingOwnerIdSchema }).strict(),
  z.object({ type: z.literal('provider'), providerId: routingIdentifierSchema }).strict(),
  z.object({ type: z.literal('quota_pool'), poolId: routingIdentifierSchema }).strict(),
]);

const routingSignalBaseShape = {
  v: z.literal(ROUTING_CONTEXT_VERSION),
  eventId: routingIdentifierSchema,
  commandId: routingIdentifierSchema,
  ownerId: routingOwnerIdSchema,
  subjectRef: routingSubjectRefV1Schema,
  reasonCode: routingIdentifierSchema,
  note: routingSummarySchema.optional(),
  source: z.enum(['manual_cvo', 'quota_probe', 'provider_error', 'health_probe', 'dispatch_success']),
  observedAt: routingEpochMsSchema,
  evidenceRef: routingReferenceSchema,
};

const assertedRoutingSignalV1Schema = z
  .object({
    ...routingSignalBaseShape,
    eventType: z.literal('asserted'),
    state: z.enum(['scarce', 'degraded', 'unavailable']),
    validUntil: routingEpochMsSchema.optional(),
    resetAt: routingEpochMsSchema.optional(),
  })
  .strict();

const recoveredRoutingSignalV1Schema = z
  .object({
    ...routingSignalBaseShape,
    eventType: z.literal('recovered'),
    state: z.literal('available'),
    closesSignalIds: z.array(routingIdentifierSchema).min(1).max(64),
  })
  .strict();

const retractedRoutingSignalV1Schema = z
  .object({
    ...routingSignalBaseShape,
    eventType: z.literal('retracted'),
    closesSignalIds: z.array(routingIdentifierSchema).min(1).max(64),
  })
  .strict();

export const routingSignalEventV1Schema = z
  .discriminatedUnion('eventType', [
    assertedRoutingSignalV1Schema,
    recoveredRoutingSignalV1Schema,
    retractedRoutingSignalV1Schema,
  ])
  .superRefine((event, ctx) => {
    if (event.eventType === 'asserted') {
      if (event.validUntil === undefined && event.resetAt === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['validUntil'],
          message: 'an asserted signal requires validUntil or resetAt',
        });
      }
      for (const field of ['validUntil', 'resetAt'] as const) {
        const boundary = event[field];
        if (boundary !== undefined && boundary <= event.observedAt) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} must be later than observedAt`,
          });
        }
      }
      return;
    }
    addRoutingDuplicateIssues(event.closesSignalIds, ['closesSignalIds'], ctx);
  });

const routingPreferenceBaseShape = {
  v: z.literal(ROUTING_CONTEXT_VERSION),
  preferenceId: routingIdentifierSchema,
  revisionId: routingIdentifierSchema,
  commandId: routingIdentifierSchema,
  ownerId: routingOwnerIdSchema,
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
  version: z.number().int().positive(),
  validFrom: routingEpochMsSchema,
};

const activeRoutingPreferenceRevisionV1Schema = z
  .object({
    ...routingPreferenceBaseShape,
    lifecycle: z.literal('active'),
    reviewAfter: routingEpochMsSchema.optional(),
    supersedesRevisionId: routingIdentifierSchema.optional(),
  })
  .strict();

const retiredRoutingPreferenceRevisionV1Schema = z
  .object({
    ...routingPreferenceBaseShape,
    lifecycle: z.literal('retired'),
    retiredAt: routingEpochMsSchema,
    retirementReason: routingSummarySchema,
    supersedesRevisionId: routingIdentifierSchema,
  })
  .strict();

function routingSubjectKey(subjectRef: z.infer<typeof routingSubjectRefV1Schema>): string {
  if (subjectRef.type === 'cat') return `cat:${subjectRef.catId}`;
  if (subjectRef.type === 'provider') return `provider:${subjectRef.providerId}`;
  return `quota_pool:${subjectRef.poolId}`;
}

export const routingPreferenceRevisionV1Schema = z
  .discriminatedUnion('lifecycle', [activeRoutingPreferenceRevisionV1Schema, retiredRoutingPreferenceRevisionV1Schema])
  .superRefine((preference, ctx) => {
    const expectsPredecessor = preference.version > 1;
    if (expectsPredecessor !== (preference.supersedesRevisionId !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supersedesRevisionId'],
        message: 'version 1 must not supersede; every later version must supersede one exact revision',
      });
    }
    if (preference.supersedesRevisionId === preference.revisionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supersedesRevisionId'],
        message: 'a revision cannot supersede itself',
      });
    }
    if (
      preference.lifecycle === 'active' &&
      preference.reviewAfter !== undefined &&
      preference.reviewAfter <= preference.validFrom
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewAfter'],
        message: 'reviewAfter must be later than validFrom',
      });
    }
    if (preference.lifecycle === 'retired') {
      if (preference.version === 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['version'],
          message: 'retirement is a terminal successor revision, not a first revision',
        });
      }
      if (preference.retiredAt < preference.validFrom) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['retiredAt'],
          message: 'retiredAt must not precede validFrom',
        });
      }
    }

    const preferKeys = preference.prefer.map(routingSubjectKey);
    const overKeys = preference.over.map(routingSubjectKey);
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
  });

export const routingQuotaPoolBindingV1Schema = z
  .object({ poolId: routingIdentifierSchema, evidenceRef: routingReferenceSchema })
  .strict();

export const routingCandidateBindingV1Schema = z
  .object({
    v: z.literal(ROUTING_CONTEXT_VERSION),
    catId: routingOwnerIdSchema,
    providerId: routingIdentifierSchema,
    provenQuotaPools: z.array(routingQuotaPoolBindingV1Schema).max(32),
  })
  .strict()
  .superRefine((candidate, ctx) => {
    addRoutingDuplicateIssues(
      candidate.provenQuotaPools.map((pool) => pool.poolId),
      ['provenQuotaPools'],
      ctx,
    );
  });

export const capabilityProfileRevisionRefV1Schema = z
  .object({
    v: z.literal(ROUTING_CONTEXT_VERSION),
    catId: routingOwnerIdSchema,
    modelId: routingIdentifierSchema,
    dossierRevision: routingReferenceSchema,
    updatedAt: routingEpochMsSchema,
    relevantSignals: z
      .array(
        z
          .object({
            kind: z.enum(['strength', 'underused_strength', 'summon_signal', 'anti_signal', 'hard_limit']),
            summary: routingSummarySchema,
            evidenceRefs: z.array(routingReferenceSchema).min(1).max(16),
          })
          .strict(),
      )
      .max(16),
    pendingProposalCount: z.number().int().nonnegative(),
  })
  .strict();

export type RoutingSubjectRefV1 = z.infer<typeof routingSubjectRefV1Schema>;
export type RoutingSignalEventV1 = z.infer<typeof routingSignalEventV1Schema>;
export type RoutingPreferenceRevisionV1 = z.infer<typeof routingPreferenceRevisionV1Schema>;
export type RoutingQuotaPoolBindingV1 = z.infer<typeof routingQuotaPoolBindingV1Schema>;
export type RoutingCandidateBindingV1 = z.infer<typeof routingCandidateBindingV1Schema>;
export type CapabilityProfileRevisionRefV1 = z.infer<typeof capabilityProfileRevisionRefV1Schema>;
