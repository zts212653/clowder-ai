import { z } from 'zod';
import { videoProjectReviewActionSchema } from './video-project-review.js';
import { videoProjectFrozenInputSchema } from './video-project-screening.js';

const id = z.string().trim().min(1).max(256);
const revision = z.number().int().positive().safe();
const page = {
  cursor: z.number().int().nonnegative().safe().default(0),
  expectedSnapshot: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
};
/** One original-message Task-bound command resource. Human decisions and media registration are deliberately absent. */
export const videoProjectCommandSchema = z
  .object({
    requestId: id,
    command: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('read'), ownerRevision: revision.optional(), ...page }).strict(),
      z.object({ kind: z.literal('review-read'), ...page }).strict(),
      z
        .object({
          kind: z.literal('save'),
          expectedOwnerRevision: revision,
          operationId: id,
          document: z.record(z.unknown()),
        })
        .strict(),
      z
        .object({
          kind: z.literal('review-act'),
          expectedRevision: revision,
          operationId: id,
          action: videoProjectReviewActionSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal('self-review'),
          expectedOwnerRevision: revision,
          operationId: id,
          id,
          input: videoProjectFrozenInputSchema,
          segmentIds: z.array(id).min(1).max(10000),
          conclusion: z.enum(['pass', 'changes-requested']),
          refs: z.array(id).min(1).max(1000),
        })
        .strict(),
    ]),
  })
  .strict();
export type VideoProjectCommand = z.infer<typeof videoProjectCommandSchema>;
