import { z } from 'zod';
import {
  videoProjectActorSchema,
  videoProjectDigestSchema,
  videoProjectIdSchema,
  videoProjectJsonSchema,
  videoProjectOriginSchema,
  videoProjectPositiveSchema,
  videoProjectTextSchema,
  videoProjectTimestampSchema,
} from './video-project-primitives.js';

export const videoProjectCheckPageSchema = z
  .object({
    id: videoProjectIdSchema,
    name: videoProjectTextSchema(1000),
    criteria: videoProjectTextSchema(8000),
    references: z.array(videoProjectIdSchema).max(1000),
    scope: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('allScenes') }).strict(),
      z
        .object({ kind: z.literal('selectedScenes'), sceneIds: z.array(videoProjectIdSchema).min(1).max(10000) })
        .strict(),
    ]),
    assignee: videoProjectActorSchema.nullable(),
    origin: videoProjectOriginSchema,
    archivedAt: videoProjectTimestampSchema.optional(),
  })
  .strict();

const checkResultFields = {
  id: videoProjectIdSchema,
  pageId: videoProjectIdSchema,
  sceneId: videoProjectIdSchema,
  inputOwnerRevision: videoProjectPositiveSchema,
  definitionDigest: videoProjectDigestSchema,
  origin: videoProjectOriginSchema,
};
export const videoProjectCheckResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...checkResultFields,
      kind: z.literal('sheet'),
      assetVersionRefs: z.array(videoProjectIdSchema).min(1).max(1000),
      recipe: videoProjectJsonSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...checkResultFields,
      kind: z.literal('coveredBy'),
      coveredByPageId: videoProjectIdSchema,
      reason: videoProjectTextSchema(8000),
    })
    .strict(),
]);

export const videoProjectDecisionEventSchema = z
  .object({
    kind: z.enum(['proposed', 'decided', 'reopened', 'withdrawn']),
    actor: videoProjectActorSchema,
    at: videoProjectTimestampSchema,
    operationId: videoProjectIdSchema,
    reason: videoProjectTextSchema(8000).optional(),
    optionId: videoProjectIdSchema.optional(),
    answer: videoProjectTextSchema(8000).optional(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.kind === 'decided' && (event.optionId === undefined) === (event.answer === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'Decision must select an option or give a free-text answer' });
    }
    if (event.kind !== 'decided' && (event.optionId !== undefined || event.answer !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'Only decided events contain answers' });
    }
    if (event.kind === 'reopened' && event.reason === undefined) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Reopening requires a reason' });
    }
  });

export const videoProjectDecisionSchema = z
  .object({
    id: videoProjectIdSchema,
    question: videoProjectTextSchema(8000),
    context: z.string().max(16000),
    options: z
      .array(
        z
          .object({
            id: videoProjectIdSchema,
            text: videoProjectTextSchema(8000),
            assetVersionRefs: z.array(videoProjectIdSchema).max(1000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(1000)
      .optional(),
    targets: z
      .object({
        sceneIds: z.array(videoProjectIdSchema).max(10000),
        segmentIds: z.array(videoProjectIdSchema).max(10000),
        assetIds: z.array(videoProjectIdSchema).max(10000),
      })
      .strict(),
    proposer: videoProjectActorSchema,
    decider: videoProjectActorSchema,
    origin: videoProjectOriginSchema,
    state: z.enum(['open', 'decided', 'withdrawn']),
    history: z.array(videoProjectDecisionEventSchema).min(1).max(10000),
  })
  .strict();
export type VideoProjectCheckPage = z.infer<typeof videoProjectCheckPageSchema>;
export type VideoProjectCheckResult = z.infer<typeof videoProjectCheckResultSchema>;
export type VideoProjectDecision = z.infer<typeof videoProjectDecisionSchema>;
