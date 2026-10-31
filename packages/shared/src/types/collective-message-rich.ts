import { z } from 'zod';
import { richBlockSchema } from '../schemas/rich-block.schema.js';

const attachmentUrl = z.string().startsWith('collective-attachment:').max(240);
export function isCollectiveAttachmentUrl(url: string): boolean {
  return attachmentUrl.safeParse(url).success;
}

const base = richBlockSchema.options;
/** The same F22 language. Public media names retained attachments, and private callbacks/approval metadata stay at their owner. */
export const collectiveMessageRichBlockSchema = z.discriminatedUnion('kind', [
  base[0].omit({ meta: true }).strict(),
  base[1].strict(),
  base[2].extend({ items: z.array(base[2].shape.items.element.strict()).min(1) }).strict(),
  base[3]
    .extend({
      items: z
        .array(base[3].shape.items.element.extend({ url: attachmentUrl }).strict())
        .min(1)
        .max(12),
    })
    .strict(),
  base[4].extend({ url: attachmentUrl, durationSec: z.number().nonnegative().optional() }).strict(),
  base[5]
    .extend({
      options: z
        .array(base[5].shape.options.element.omit({ action: true }).strict())
        .min(1)
        .max(100),
    })
    .strict(),
  base[6].extend({ url: attachmentUrl }).strict(),
  base[7].strict(),
]);
export type CollectiveMessageRichBlock = z.infer<typeof collectiveMessageRichBlockSchema>;

export function collectiveRichMediaReferences(blocks: readonly CollectiveMessageRichBlock[]) {
  return blocks.flatMap<{ url: string; kind: 'image' | 'audio' | 'file' }>((block) => {
    if (block.kind === 'media_gallery') return block.items.map((item) => ({ url: item.url, kind: 'image' as const }));
    if (block.kind === 'audio') return [{ url: block.url, kind: 'audio' as const }];
    if (block.kind === 'file') return [{ url: block.url, kind: 'file' as const }];
    return [];
  });
}

export function requireDistinctRichBlocks(
  blocks: readonly CollectiveMessageRichBlock[] | undefined,
  context: z.RefinementCtx,
) {
  if (new Set(blocks?.map((block) => block.id)).size !== (blocks?.length ?? 0))
    context.addIssue({ code: 'custom', path: ['richBlocks'], message: 'Duplicate rich block identity' });
  for (const block of blocks ?? []) {
    if (block.kind !== 'interactive') continue;
    const ids = new Set(block.options.map((option) => option.id));
    if (ids.size !== block.options.length || block.selectedIds?.some((id) => !ids.has(id)))
      context.addIssue({
        code: 'custom',
        path: ['richBlocks'],
        message: 'Interactive choices require distinct current option identities',
      });
  }
}
