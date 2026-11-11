import { z } from 'zod';

/** Local raster assets only: no remote tracking URL, data URI, SVG or path traversal. */
export const backgroundImageUrlSchema = z
  .string()
  .regex(/^\/(?:uploads|backgrounds)\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:png|jpg|jpeg|webp)$/i);

export const backgroundOpacitySchema = z
  .object({ light: z.number().min(0).max(0.4), dark: z.number().min(0).max(0.4) })
  .strict();

export const chatBackgroundSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z
    .object({
      kind: z.literal('image'),
      url: backgroundImageUrlSchema,
      name: z.string().trim().min(1).max(160),
      placement: z.enum(['fill', 'center', 'tile']),
      opacity: backgroundOpacitySchema,
      recommendedOpacity: backgroundOpacitySchema,
    })
    .strict(),
]);

export type ChatBackground = z.infer<typeof chatBackgroundSchema>;
export type ChatBackgroundImage = Extract<ChatBackground, { kind: 'image' }>;
export type BackgroundPlacement = ChatBackgroundImage['placement'];
export type BackgroundOpacity = ChatBackgroundImage['opacity'];

export const chatBackgroundPreferencesSchema = z.object({
  global: chatBackgroundSchema.optional(),
  threads: z.record(chatBackgroundSchema),
});
export type ChatBackgroundPreferences = z.infer<typeof chatBackgroundPreferencesSchema>;

export const NO_CHAT_BACKGROUND: ChatBackground = { kind: 'none' };

/** An explicit none overrides the default; an absent thread entry inherits it. */
export function resolveChatBackground(
  preferences: ChatBackgroundPreferences,
  threadId?: string | null,
): ChatBackground {
  return (threadId ? preferences.threads[threadId] : undefined) ?? preferences.global ?? NO_CHAT_BACKGROUND;
}

export const appearanceImageIdSchema = z.string().regex(/^user\.[0-9a-f-]{36}$/);
export const appearanceImageSchema = z
  .object({
    id: appearanceImageIdSchema,
    name: z.string().min(1).max(255),
    mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
    source: z.string().regex(/^\/api\/config\/chat-background\/images\/user\.[0-9a-f-]{36}$/),
  })
  .strict();
export type AppearanceImage = z.infer<typeof appearanceImageSchema>;
