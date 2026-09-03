import { routingPreflightDecisionV1Schema, routingSubjectRefV1Schema } from '@cat-cafe/shared';
import { z } from 'zod';

const epochMsSchema = z.number().int().finite().nonnegative();
const identifierSchema = z.string().trim().min(1).max(200);
const ownerIdSchema = z.string().trim().min(1).max(120);
const referenceSchema = z.string().trim().min(1).max(500);
const summarySchema = z.string().trim().min(1).max(1_000);
const healthSubjectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cat'), catId: ownerIdSchema }).strict(),
  z.object({ type: z.literal('provider'), providerId: identifierSchema }).strict(),
]);

export const ROUTING_HEALTH_MAX_VALIDITY_MS = 5 * 60_000;

const observationBaseShape = {
  v: z.literal(1),
  ownerId: ownerIdSchema,
  observationId: identifierSchema,
  observedAt: epochMsSchema,
  evidenceRef: referenceSchema,
};

const quotaSnapshotObservationV1Schema = z
  .object({
    ...observationBaseShape,
    kind: z.literal('quota_snapshot'),
    providerId: identifierSchema,
    items: z
      .array(
        z
          .object({
            poolId: identifierSchema.optional(),
            usedPercent: z.number().finite().min(0).max(100),
            percentKind: z.enum(['used', 'remaining']).optional(),
            resetsAt: epochMsSchema.optional(),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();

const providerHealthObservationV1Schema = z
  .object({
    ...observationBaseShape,
    kind: z.literal('provider_health'),
    subjectRef: healthSubjectSchema,
    authority: z.enum(['exact_cat_observation', 'canonical_provider_health', 'independent_route_threshold']),
    state: z.enum(['available', 'degraded', 'unavailable']),
    validUntil: epochMsSchema.optional(),
  })
  .strict()
  .superRefine((observation, ctx) => {
    if (observation.subjectRef.type === 'provider' && observation.authority === 'exact_cat_observation') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authority'],
        message: 'provider-wide health requires provider-wide authority',
      });
    }
    if (observation.state === 'available') {
      if (observation.validUntil !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['validUntil'],
          message: 'available health is recovery evidence and does not carry negative validity',
        });
      }
      return;
    }
    if (
      observation.validUntil === undefined ||
      observation.validUntil <= observation.observedAt ||
      observation.validUntil - observation.observedAt > ROUTING_HEALTH_MAX_VALIDITY_MS
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validUntil'],
        message: 'negative health requires future validity bounded to five minutes',
      });
    }
  });

const dispatchTerminalObservationV1Schema = z
  .object({
    ...observationBaseShape,
    kind: z.literal('dispatch_terminal'),
    catId: ownerIdSchema,
    status: z.enum(['succeeded', 'failed', 'canceled', 'interrupted']),
    failureClass: z
      .enum(['quota_exhausted', 'authentication_rejected', 'provider_unreachable', 'provider_timeout'])
      .optional(),
    preflightDecision: routingPreflightDecisionV1Schema,
  })
  .strict()
  .superRefine((observation, ctx) => {
    const expectsFailureClass = observation.status === 'failed';
    if (expectsFailureClass !== (observation.failureClass !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureClass'],
        message: 'failed dispatch requires one stable failure class; other terminals must omit it',
      });
    }
    if (observation.preflightDecision.ownerId !== observation.ownerId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preflightDecision', 'ownerId'],
        message: 'dispatch terminal and preflight decision must belong to the same owner',
      });
    }
    if (!observation.preflightDecision.targets.some((target) => target.targetCatId === observation.catId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preflightDecision', 'targets'],
        message: 'dispatch terminal requires preflight evidence for the exact cat',
      });
    }
  });

export const routingSignalObservationV1Schema = z.union([
  quotaSnapshotObservationV1Schema,
  providerHealthObservationV1Schema,
  dispatchTerminalObservationV1Schema,
]);

const automaticAssertionSourcesSchema = z.enum(['quota_probe', 'provider_error', 'health_probe']);
const automaticRecoverySourcesSchema = z.enum(['quota_probe', 'health_probe', 'dispatch_success']);

export const automaticRoutingSignalAssertionInputSchema = z
  .object({
    ownerId: ownerIdSchema,
    observationId: identifierSchema,
    subjectRef: routingSubjectRefV1Schema,
    state: z.enum(['scarce', 'degraded', 'unavailable']),
    reasonCode: identifierSchema,
    note: summarySchema.optional(),
    source: automaticAssertionSourcesSchema,
    observedAt: epochMsSchema,
    evidenceRef: referenceSchema,
    validUntil: epochMsSchema.optional(),
    resetAt: epochMsSchema.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.validUntil === undefined && input.resetAt === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validUntil'],
        message: 'automatic assertion requires validUntil or resetAt',
      });
    }
    for (const field of ['validUntil', 'resetAt'] as const) {
      const boundary = input[field];
      if (boundary !== undefined && boundary <= input.observedAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} must be later than observedAt`,
        });
      }
    }
  });

export const automaticRoutingSignalRecoveryInputSchema = z
  .object({
    ownerId: ownerIdSchema,
    observationId: identifierSchema,
    subjectRef: routingSubjectRefV1Schema,
    reasonCode: identifierSchema,
    note: summarySchema.optional(),
    source: automaticRecoverySourcesSchema,
    observedAt: epochMsSchema,
    evidenceRef: referenceSchema,
    closesSignalIds: z.array(identifierSchema).min(1).max(64),
    recoverableSources: z.array(automaticAssertionSourcesSchema).min(1).max(3),
  })
  .strict()
  .superRefine((input, ctx) => {
    for (const [field, values] of [
      ['closesSignalIds', input.closesSignalIds],
      ['recoverableSources', input.recoverableSources],
    ] as const) {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field, index],
            message: 'duplicate values are not allowed',
          });
        }
        seen.add(value);
      });
    }
  });

export type RoutingSignalObservationV1 = z.infer<typeof routingSignalObservationV1Schema>;
export type ProviderHealthObservationV1 = Extract<RoutingSignalObservationV1, { kind: 'provider_health' }>;
export type AutomaticRoutingSignalAssertionInput = z.infer<typeof automaticRoutingSignalAssertionInputSchema>;
export type AutomaticRoutingSignalRecoveryInput = z.infer<typeof automaticRoutingSignalRecoveryInputSchema>;
