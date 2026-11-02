// Frozen v1 reader from 5cef30b2f1402f506f677f7522fe7bd1bc7ab101:packages/shared/src/chat-background.ts; blob 31d0c9b0faae2beb3f4137787e4592d2c735b3ef.
// TypeScript erased; only the two store import locations are rebased to the fixture/current unchanged disk IO.
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
export const chatBackgroundPreferencesSchema = z.object({
  global: chatBackgroundSchema.optional(),
  threads: z.record(chatBackgroundSchema),
});
export const NO_CHAT_BACKGROUND = { kind: 'none' };
/** An explicit none overrides the default; an absent thread entry inherits it. */
export function resolveChatBackground(preferences, threadId) {
  return (threadId ? preferences.threads[threadId] : undefined) ?? preferences.global ?? NO_CHAT_BACKGROUND;
}
