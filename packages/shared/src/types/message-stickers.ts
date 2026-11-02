import { z } from 'zod';

/** Version 1 retains the original approved F321 image bytes. Characters are artwork choices, never a member roster.
 * Bytes remain at the original Host; publishing a plugin does not redistribute this catalogue's artwork. */
export const MESSAGE_STICKER_PACK_ID = 'cafe-expressions' as const;
export const MESSAGE_STICKER_PACK_REVISION = 1 as const;

import { MESSAGE_STICKER_CATALOG } from './message-sticker-catalog.js';

export { MESSAGE_STICKER_CATALOG } from './message-sticker-catalog.js';
export type MessageStickerCatalogEntry = (typeof MESSAGE_STICKER_CATALOG)[number];
export function findMessageSticker(id: string) {
  return MESSAGE_STICKER_CATALOG.find((entry) => entry.id === id);
}
export function findMessageStickerByDigest(digest: string) {
  return MESSAGE_STICKER_CATALOG.find((entry) => entry.blobDigest === digest);
}
export const messageStickerSchema = z
  .object({
    v: z.literal(1),
    packId: z.literal(MESSAGE_STICKER_PACK_ID),
    packRevision: z.literal(MESSAGE_STICKER_PACK_REVISION),
    stickerId: z.string().min(1).max(80),
    blobDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .strict()
  .refine(
    (value) => findMessageSticker(value.stickerId)?.blobDigest === value.blobDigest,
    'Sticker must name an immutable catalogue image',
  );
export type MessageSticker = z.infer<typeof messageStickerSchema>;
export function messageStickerReference(id: string): MessageSticker {
  const entry = findMessageSticker(id);
  if (!entry) throw new Error('Unknown sticker catalogue image');
  return {
    v: 1,
    packId: MESSAGE_STICKER_PACK_ID,
    packRevision: MESSAGE_STICKER_PACK_REVISION,
    stickerId: entry.id,
    blobDigest: entry.blobDigest,
  };
}
