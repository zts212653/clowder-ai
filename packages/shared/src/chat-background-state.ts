import { z } from 'zod';
import {
  backgroundOpacitySchema,
  type ChatBackground,
  type ChatBackgroundImage,
  chatBackgroundPreferencesSchema,
  chatBackgroundSchema,
  NO_CHAT_BACKGROUND,
} from './chat-background.js';

/** Sidecar fields never enter the strict v1 image record or an old API's stored choices. */
export const chatBackgroundMetadataSchema = z
  .object({
    readableOpacity: backgroundOpacitySchema.optional(),
    manualOpacity: z.object({ light: z.boolean().optional(), dark: z.boolean().optional() }).strict().optional(),
  })
  .strict();
export type ChatBackgroundMetadata = z.infer<typeof chatBackgroundMetadataSchema>;
export const chatBackgroundMetadataEntrySchema = chatBackgroundMetadataSchema.extend({
  background: chatBackgroundSchema,
});
export type ChatBackgroundMetadataEntry = z.infer<typeof chatBackgroundMetadataEntrySchema>;
export const chatBackgroundResponseSchema = chatBackgroundPreferencesSchema.extend({
  metadata: z
    .object({
      global: chatBackgroundMetadataEntrySchema.optional(),
      threads: z.record(chatBackgroundMetadataEntrySchema),
    })
    .optional(),
});
export type ChatBackgroundResponse = z.infer<typeof chatBackgroundResponseSchema>;
export type ChatBackgroundImageState = ChatBackgroundImage & ChatBackgroundMetadata;
export type ChatBackgroundState = Exclude<ChatBackground, ChatBackgroundImage> | ChatBackgroundImageState;
export type ChatBackgroundStatePreferences = {
  global?: ChatBackgroundState;
  threads: Record<string, ChatBackgroundState>;
};

/** Bind metadata to the complete v1 value: an older writer cannot leave stale intent attached to its replacement. */
export function backgroundMetadataMatches(background: ChatBackground, entry: ChatBackgroundMetadataEntry): boolean {
  return (
    JSON.stringify(chatBackgroundSchema.parse(background)) ===
    JSON.stringify(chatBackgroundSchema.parse(entry.background))
  );
}

export function serializeChatBackgroundState(background: ChatBackgroundState | null): {
  background: ChatBackground | null;
  metadata?: ChatBackgroundMetadata;
} {
  if (!background || background.kind === 'none') return { background };
  const { readableOpacity, manualOpacity, ...legacy } = background;
  return {
    background: legacy,
    ...(readableOpacity || manualOpacity ? { metadata: { readableOpacity, manualOpacity } } : {}),
  };
}

export function decodeChatBackgroundPreferences(value: unknown): ChatBackgroundStatePreferences {
  const response = chatBackgroundResponseSchema.parse(value);
  const hydrate = (background: ChatBackground, entry?: ChatBackgroundMetadataEntry): ChatBackgroundState => {
    if (background.kind !== 'image' || !entry || !backgroundMetadataMatches(background, entry)) return background;
    const { background: _binding, ...metadata } = entry;
    return { ...background, ...metadata };
  };
  return {
    ...(response.global ? { global: hydrate(response.global, response.metadata?.global) } : {}),
    threads: Object.fromEntries(
      Object.entries(response.threads).map(([id, background]) => [
        id,
        hydrate(background, response.metadata?.threads[id]),
      ]),
    ),
  };
}

export function resolveChatBackgroundState(
  preferences: ChatBackgroundStatePreferences,
  threadId?: string | null,
): ChatBackgroundState {
  return (threadId ? preferences.threads[threadId] : undefined) ?? preferences.global ?? NO_CHAT_BACKGROUND;
}
