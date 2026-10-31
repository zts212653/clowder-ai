import { z } from 'zod';
import {
  evolutionArchivePublicationSchema,
  evolutionArchiveVersionSchema,
  HARNESS_HISTORY_IGNORED_FIELD_PATH_MAX_COUNT,
  HARNESS_HISTORY_IGNORED_FIELD_PATH_MAX_LENGTH,
} from './capability-evolution-exploration.js';
import { bounded, ownerTruthRefV1Schema, timestampSchema } from './capability-evolution-refs.js';

export const harnessHistoryCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const commonCommand = {
  expectedRevision: revision,
  clientMessageId: bounded(240),
  reason: bounded(1_000),
};
export const harnessHistoryPublicationCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...commonCommand, action: z.literal('publish'), sourceRevision: harnessHistoryCommitSchema }).strict(),
  z.object({ ...commonCommand, action: z.literal('restore'), restoreRevision: revision }).strict(),
]);

export const harnessHistoryFailureCodeSchema = z.enum([
  'source_unavailable',
  'source_not_on_main',
  'invalid_history',
  'unsupported_history_schema',
  'restore_not_found',
]);
export const harnessHistoryPublicationAttemptSchema = z
  .object({
    revision: revision.refine((value) => value > 0),
    clientMessageId: bounded(240),
    action: z.enum(['publish', 'restore']),
    status: z.enum(['published', 'failed']),
    sourceRevision: harnessHistoryCommitSchema.optional(),
    restoreRevision: revision.optional(),
    actorRef: bounded(240),
    originRef: bounded(2_000),
    reason: bounded(1_000),
    occurredAt: timestampSchema,
    failureCode: harnessHistoryFailureCodeSchema.optional(),
    ignoredFieldPaths: z
      .array(bounded(HARNESS_HISTORY_IGNORED_FIELD_PATH_MAX_LENGTH))
      .max(HARNESS_HISTORY_IGNORED_FIELD_PATH_MAX_COUNT)
      .optional(),
  })
  .strict()
  .superRefine((attempt, ctx) => {
    if (attempt.status === 'published' && (!attempt.sourceRevision || attempt.failureCode))
      ctx.addIssue({ code: 'custom', message: 'a successful publication requires its immutable source' });
    if (attempt.status === 'failed' && !attempt.failureCode)
      ctx.addIssue({ code: 'custom', message: 'a failed publication requires its failure code' });
  });

export const harnessHistoryPublicationVersionSchema = evolutionArchiveVersionSchema.extend({
  sourceRevision: harnessHistoryCommitSchema,
});

export const harnessHistoryPublicationStatusSchema = evolutionArchivePublicationSchema
  .extend({
    schemaVersion: z.literal(1),
    programRef: ownerTruthRefV1Schema,
    objectRef: ownerTruthRefV1Schema,
    revision,
    current: harnessHistoryPublicationVersionSchema,
    attempts: z.array(harnessHistoryPublicationAttemptSchema).max(50),
    hasMore: z.boolean(),
    selected: harnessHistoryPublicationVersionSchema,
  })
  .strict();

export type HarnessHistoryPublicationCommand = z.infer<typeof harnessHistoryPublicationCommandSchema>;
export type HarnessHistoryPublicationAttempt = z.infer<typeof harnessHistoryPublicationAttemptSchema>;
export type HarnessHistoryPublicationVersion = z.infer<typeof harnessHistoryPublicationVersionSchema>;
export type HarnessHistoryPublicationStatus = z.infer<typeof harnessHistoryPublicationStatusSchema>;
export type HarnessHistoryFailureCode = z.infer<typeof harnessHistoryFailureCodeSchema>;

export function harnessHistoryPublicationRef(programId: string, version: string) {
  return { ownerFeatureId: 'F314', ownerStateRef: `harness-history:publication:${programId}`, version };
}
export function isHarnessHistoryPublicationRef(ref: { ownerFeatureId: string; ownerStateRef: string } | undefined) {
  return ref?.ownerFeatureId === 'F314' && ref.ownerStateRef.startsWith('harness-history:publication:');
}
