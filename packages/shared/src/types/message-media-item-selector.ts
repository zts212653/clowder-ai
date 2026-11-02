import { z } from 'zod';

const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value && !value.includes('\0'));
const index = z.number().int().min(0).max(10000);

export const messageMediaItemSelectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('media-gallery'), blockId: id, itemIndex: index }).strict(),
  z.object({ kind: z.literal('rich-file'), blockId: id }).strict(),
  z.object({ kind: z.literal('content-block'), index }).strict(),
]);
export type MessageMediaItemSelector = z.infer<typeof messageMediaItemSelectorSchema>;
