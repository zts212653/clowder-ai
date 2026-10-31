import { z } from 'zod';

export const conversationViewPreferenceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('group') }).strict(),
  z.object({ mode: z.literal('cat'), catId: z.string().trim().min(1) }).strict(),
]);

export type ConversationViewPreference = z.infer<typeof conversationViewPreferenceSchema>;

export interface ConversationViewPreferences {
  /** F322: per-thread presentation only; routing and recipients are unaffected. */
  threads?: Record<string, ConversationViewPreference>;
}

export const conversationViewPreferenceSourceSchema = z.enum(['product', 'thread', 'participant_missing']);

export type ConversationViewPreferenceSource = z.infer<typeof conversationViewPreferenceSourceSchema>;

export const conversationViewPreferenceSnapshotSchema = z
  .object({
    stored: conversationViewPreferenceSchema.nullable(),
    effective: conversationViewPreferenceSchema,
    source: conversationViewPreferenceSourceSchema,
  })
  .strict();

export type ConversationViewPreferenceSnapshot = z.infer<typeof conversationViewPreferenceSnapshotSchema>;
