import { collectiveReactionEmojiSchema } from '@cat-cafe/shared';
import { z } from 'zod';

export const reactionRecordSchema = z
  .object({
    v: z.literal(1),
    reactionId: z.string().regex(/^reaction_[A-Za-z0-9_-]{8,}$/),
    serviceInstanceId: z.string(),
    collectiveId: z.string(),
    eventId: z.string(),
    emoji: collectiveReactionEmojiSchema,
    humanId: z.string(),
    active: z.boolean(),
    revision: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    history: z
      .array(
        z
          .object({
            revision: z.number().int().positive(),
            active: z.boolean(),
            at: z.string().datetime(),
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
  })
  .strict()
  .superRefine((reaction, context) => {
    for (const [index, entry] of reaction.history.entries()) {
      if (entry.revision !== index + 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['history', index, 'revision'],
          message: 'Reaction history revisions must be consecutive',
        });
      }
    }
    const first = reaction.history[0];
    const last = reaction.history.at(-1);
    if (first?.at !== reaction.createdAt || last?.at !== reaction.updatedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['history'],
        message: 'Reaction timestamps must match the first and current history entries',
      });
    }
    if (last?.revision !== reaction.revision || last?.active !== reaction.active) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['history'],
        message: 'Reaction current state must match its latest history entry',
      });
    }
  });
