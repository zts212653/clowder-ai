import { z } from 'zod';
import { collectiveConnectionCoordinatesSchema, collectiveCoordinatesSchema } from './collective.js';
import { collectiveCollaborationActorSchema } from './collective-collaboration-actor.js';
import { collectiveRoadmapIdSchema, collectiveWorkIdSchema } from './collective-collaboration-identifiers.js';

const id = z.string().min(1).max(200);
export const collectiveMaterialWitnessSchema = z
  .object({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    readAt: z.string().datetime(),
    providerRevision: z.string().min(1).max(500).optional(),
    /** Generation scope is not a claim of an immutable transcript version. */
    generationScope: z.string().min(1).max(500).optional(),
  })
  .strict();
export const collectiveMaterialSourceResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('available'),
      sourceKey: z.string().min(1).max(1000),
      sourceRef: z.string().min(1).max(2048),
      witness: collectiveMaterialWitnessSchema,
      material: z
        .object({
          kind: z.enum(['pr', 'issue', 'meeting']),
          title: z.string().min(1).max(500),
          author: z.string().max(200).optional(),
          occurredAt: z.string().datetime().optional(),
          url: z.string().url().max(2048).optional(),
          clauses: z
            .array(
              z
                .object({
                  clauseId: id,
                  text: z.string().min(1).max(32_000),
                  suggestedWorkId: collectiveWorkIdSchema.optional(),
                  suggestedBy: collectiveCollaborationActorSchema.optional(),
                  dateHint: z.string().max(300).optional(),
                })
                .strict(),
            )
            .max(200),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      status: z.literal('unavailable'),
      reason: z.enum(['access_revoked', 'deleted', 'owner_unavailable', 'not_published']),
    })
    .strict(),
]);
export const collectiveMaterialPublicationSchema = collectiveConnectionCoordinatesSchema
  .extend({
    publicationId: id,
    roadmapId: collectiveRoadmapIdSchema,
    channelId: id,
    sourceEventId: id,
    humanId: id,
    provider: z.enum(['github', 'feishu']),
    sourceId: z.string().min(1).max(2048),
    actor: collectiveCollaborationActorSchema,
    publishedAt: z.string().datetime(),
    state: z.enum(['pending', 'published', 'withdrawn']),
    sourceKey: z.string().min(1).max(1000).optional(),
    sourceRef: z.string().min(1).max(2048).optional(),
    witness: collectiveMaterialWitnessSchema.optional(),
  })
  .strict();
export const collectiveMaterialDecisionSchema = z
  .object({
    action: z.enum(['create', 'merge', 'reference', 'ignore']),
    actor: collectiveCollaborationActorSchema,
    at: z.string().datetime(),
    requestId: id,
    workId: collectiveWorkIdSchema.optional(),
    witness: collectiveMaterialWitnessSchema,
  })
  .strict();
export const collectiveMaterialRecordSchema = collectiveCoordinatesSchema
  .extend({
    materialId: id,
    roadmapId: collectiveRoadmapIdSchema,
    sourceKey: z.string().min(1).max(1000),
    publicationIds: z.array(id).min(1),
    revision: z.number().int().positive(),
    firstWitness: collectiveMaterialWitnessSchema,
    currentWitness: collectiveMaterialWitnessSchema,
    witnesses: z.array(collectiveMaterialWitnessSchema).min(1),
    decisions: z.record(id, collectiveMaterialDecisionSchema),
    selections: z
      .array(
        z
          .object({
            clauseId: id,
            witness: collectiveMaterialWitnessSchema,
            actor: collectiveCollaborationActorSchema,
            at: z.string().datetime(),
            suggestedWorkId: collectiveWorkIdSchema.optional(),
          })
          .strict(),
      )
      .optional(),
    disposition: collectiveMaterialDecisionSchema.optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export const collectiveMaterialLinkSchema = z
  .object({
    materialId: id,
    publicationId: id,
    clauseId: id.optional(),
    sourceRef: z.string().max(2048),
    witness: collectiveMaterialWitnessSchema,
    actor: collectiveCollaborationActorSchema,
    at: z.string().datetime(),
  })
  .strict();
export const collectiveMaterialItemSchema = collectiveMaterialRecordSchema
  .extend({
    publication: collectiveMaterialPublicationSchema,
    material: collectiveMaterialSourceResultSchema.options[0].shape.material,
    currentness: z.enum(['available_same', 'revised']),
  })
  .strict();
export const collectiveMaterialListSchema = z
  .object({
    items: z.array(collectiveMaterialItemSchema),
    pendingCount: z.number().int().nonnegative(),
    unavailable: z.array(z.object({ materialId: id, revision: z.number().int().positive() }).strict()),
  })
  .strict();
const command = collectiveCoordinatesSchema.extend({ requestId: id });
export const publishCollectiveMaterialRequestSchema = command
  .extend({
    roadmapId: collectiveRoadmapIdSchema,
    connectionId: id,
    provider: z.enum(['github', 'feishu']),
    sourceId: z.string().trim().min(1).max(2048),
  })
  .strict()
  .superRefine((input, context) => {
    const valid =
      input.provider === 'github'
        ? /^(?:(?:pr|issue):[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*#[1-9]\d*|https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\/(?:pull|issues)\/[1-9]\d*\/?)$/.test(
            input.sourceId,
          )
        : /^(?:[a-f0-9]{64}|feishu:\/\/meeting-artifacts\/(?:minute|note)\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\?revision=[^\s]{1,500})$/.test(
            input.sourceId,
          );
    if (!valid)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceId'],
        message: 'Choose an exact registered source reference',
      });
  });
export const listCollectiveMaterialsRequestSchema = collectiveCoordinatesSchema
  .extend({ roadmapId: collectiveRoadmapIdSchema })
  .strict();
const sortBase = command.extend({ materialId: id, expectedRevision: z.number().int().positive() });
export const sortCollectiveMaterialRequestSchema = z.discriminatedUnion('action', [
  sortBase
    .extend({
      action: z.literal('create'),
      clauseId: id,
      expectedRoadmapRevision: z.number().int().positive(),
      title: z.string().trim().min(1).max(200),
      intendedOutcome: z.string().trim().min(1).max(32_000),
    })
    .strict(),
  sortBase
    .extend({
      action: z.literal('merge'),
      clauseId: id,
      workId: collectiveWorkIdSchema,
      expectedWorkRevision: z.number().int().positive(),
    })
    .strict(),
  sortBase.extend({ action: z.literal('reference') }).strict(),
  sortBase.extend({ action: z.literal('ignore'), clauseId: id.optional() }).strict(),
]);
export const collectiveMaterialOperationSchema = z
  .object({
    relayRef: id,
    action: z.enum(['publish', 'read']),
    publication: collectiveMaterialPublicationSchema,
  })
  .strict();
export type CollectiveMaterialPublication = z.infer<typeof collectiveMaterialPublicationSchema>;
export function sameCollectiveMaterialWitness(
  left: z.infer<typeof collectiveMaterialWitnessSchema>,
  right: z.infer<typeof collectiveMaterialWitnessSchema>,
) {
  return (
    left.digest === right.digest &&
    left.providerRevision === right.providerRevision &&
    left.generationScope === right.generationScope
  );
}
export type CollectiveMaterialRecord = z.infer<typeof collectiveMaterialRecordSchema>;
export type CollectiveMaterialItem = z.infer<typeof collectiveMaterialItemSchema>;
export type CollectiveMaterialSourceResult = z.infer<typeof collectiveMaterialSourceResultSchema>;
export type CollectiveMaterialOperation = z.infer<typeof collectiveMaterialOperationSchema>;
export type CollectiveMaterialDecision = z.infer<typeof collectiveMaterialDecisionSchema>;
export type SortCollectiveMaterialRequest = z.infer<typeof sortCollectiveMaterialRequestSchema>;
export interface CollectiveMaterialSourcePort {
  execute(
    operation: CollectiveMaterialOperation,
    authority: { reauthorize(): Promise<CollectiveMaterialPublication> },
  ): Promise<CollectiveMaterialSourceResult>;
}
