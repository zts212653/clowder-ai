import { z } from 'zod';
import { videoProjectIdSchema, videoProjectTimestampSchema } from './video-project-primitives.js';
import { videoProjectFrozenInputSchema } from './video-project-screening.js';

/** An authenticated attestation is bookkeeping, never a Human approval or rendering change. */
export const videoProjectSelfReviewSchema = z
  .object({
    id: videoProjectIdSchema,
    input: videoProjectFrozenInputSchema,
    actor: z.object({ kind: z.literal('cat'), actorId: videoProjectIdSchema }).strict(),
    at: videoProjectTimestampSchema,
    operationId: videoProjectIdSchema,
    segmentIds: z
      .array(videoProjectIdSchema)
      .min(1)
      .max(10000)
      .refine((ids) => new Set(ids).size === ids.length, 'Self-review segment references must be unique'),
    conclusion: z.enum(['pass', 'changes-requested']),
    refs: z.array(videoProjectIdSchema).min(1).max(1000),
  })
  .strict();
export type VideoProjectSelfReview = z.infer<typeof videoProjectSelfReviewSchema>;

export const videoProjectSelfReviewsSchema = z
  .array(videoProjectSelfReviewSchema)
  .max(10000)
  .superRefine((items, ctx) => {
    for (const field of ['id', 'operationId'] as const) {
      const seen = new Set<string>();
      items.forEach((item, index) => {
        if (seen.has(item[field]))
          ctx.addIssue({ code: 'custom', path: [index, field], message: 'Self-review fact must be unique' });
        seen.add(item[field]);
      });
    }
  });
