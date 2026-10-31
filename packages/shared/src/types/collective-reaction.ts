import { z } from 'zod';
import { collectiveCoordinatesSchema, collectiveEventIdSchema, collectiveHumanIdSchema } from './collective.js';

export const COLLECTIVE_REACTION_EMOJIS = ['👍', '❤️', '🎉', '👀', '🐾'] as const;

export const collectiveReactionEmojiSchema = z.enum(COLLECTIVE_REACTION_EMOJIS);

export const collectiveReactionSummarySchema = collectiveCoordinatesSchema
  .extend({
    eventId: collectiveEventIdSchema,
    emoji: collectiveReactionEmojiSchema,
    humanIds: z.array(collectiveHumanIdSchema).max(10_000),
  })
  .strict();

export const setCollectiveReactionRequestSchema = collectiveCoordinatesSchema
  .extend({
    requestId: z.string().trim().min(1).max(200),
    eventId: collectiveEventIdSchema,
    emoji: collectiveReactionEmojiSchema,
    active: z.boolean(),
  })
  .strict();

export type CollectiveReactionEmoji = z.infer<typeof collectiveReactionEmojiSchema>;
export type CollectiveReactionSummary = z.infer<typeof collectiveReactionSummarySchema>;
export type SetCollectiveReactionRequest = z.infer<typeof setCollectiveReactionRequestSchema>;
