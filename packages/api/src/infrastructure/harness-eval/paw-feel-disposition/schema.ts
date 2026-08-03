import { PAW_FEEL_NO_ACTION_REASONS, type PawFeelDispositionEvent } from '@cat-cafe/shared';
import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);
const isoDateTime = z.string().datetime({ offset: true });
const sha256Digest = z.string().regex(/^[a-f0-9]{64}$/);

export const PawFeelDispositionActorSchema = z
  .object({
    kind: z.enum(['cat', 'cvo', 'automation', 'migration']),
    id: nonEmptyString,
  })
  .strict();

export const PawFeelSourceRefSchema = z
  .object({
    sourceMessageId: nonEmptyString,
    sourceThreadId: nonEmptyString,
    sourceCatId: nonEmptyString,
    markerDigest: sha256Digest,
    sameDigestOrdinal: z.number().int().nonnegative(),
    markerIndex: z.number().int().nonnegative(),
  })
  .strict();

const eventBaseSchema = z
  .object({
    eventId: nonEmptyString,
    signalId: nonEmptyString,
    actor: PawFeelDispositionActorSchema,
    occurredAt: isoDateTime,
  })
  .strict();

export const PawFeelDispositionEventSchema = z.discriminatedUnion('type', [
  eventBaseSchema
    .extend({
      type: z.literal('discovered'),
      source: PawFeelSourceRefSchema,
      backfilled: z.boolean(),
      captureMethod: z.enum(['typed', 'legacy_parser']).default('legacy_parser'),
      captureAssessment: z.enum(['confirmed', 'ambiguous', 'contaminated']).default('ambiguous'),
    })
    .strict(),
  eventBaseSchema.extend({ type: z.literal('seen') }).strict(),
  eventBaseSchema
    .extend({
      type: z.literal('route_pending'),
      targetThreadId: nonEmptyString.optional(),
      ownerEvidenceRef: nonEmptyString.optional(),
      proposalId: nonEmptyString.optional(),
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('routed'),
      targetThreadId: nonEmptyString.optional(),
      proposalId: nonEmptyString.optional(),
      receiptRef: nonEmptyString,
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('route_reopened'),
      rejectionRef: nonEmptyString,
      reasonCode: nonEmptyString,
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('closed'),
      reasonCode: nonEmptyString,
      outcomeRef: nonEmptyString,
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('duplicate'),
      duplicateOf: nonEmptyString,
      ownerCatId: nonEmptyString.optional(),
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('no_action'),
      reasonCode: z.enum(PAW_FEEL_NO_ACTION_REASONS),
      ownerCatId: nonEmptyString.optional(),
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('fix'),
      ownerCatId: nonEmptyString,
      taskId: nonEmptyString,
      leaseId: nonEmptyString,
      leaseGeneration: z.number().int().nonnegative(),
      custodyEvidenceRef: nonEmptyString,
    })
    .strict(),
]);

export function parsePawFeelDispositionEvent(raw: unknown): PawFeelDispositionEvent {
  return PawFeelDispositionEventSchema.parse(raw) as PawFeelDispositionEvent;
}
