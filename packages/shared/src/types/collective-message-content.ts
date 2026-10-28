import { z } from 'zod';
import { QuoteContextAttachmentSchema } from '../schemas/quote-context-attachment.schema.js';
import {
  type CollectiveMessageRichBlock,
  collectiveMessageRichBlockSchema,
  collectiveRichMediaReferences,
  requireDistinctRichBlocks,
} from './collective-message-rich.js';
import { messageStickerSchema } from './message-stickers.js';

/** Same F063 quote object; Channel publication cannot borrow private Thread/file authority. */
export const collectiveMessageQuoteSchema = QuoteContextAttachmentSchema.refine(
  (quote) => quote.source.kind === 'collective_message',
  'Channel quotes require a public Channel source',
);
export type CollectiveMessageQuote = z.infer<typeof collectiveMessageQuoteSchema>;

/** Immutable owner references only. Private drafts, signed URLs and bytes never enter an event. */
export const collectiveMessageAttachmentSchema = z
  .object({
    v: z.literal(1),
    sticker: messageStickerSchema.optional(),
    attachmentId: z.string().regex(/^att_[A-Za-z0-9_-]{8,120}$/),
    contentRef: z.string().startsWith('collective-attachment:').max(240),
    ownerRevision: z.literal(1),
    ownerReceiptRef: z.string().trim().min(1).max(240),
    blobDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    byteLength: z
      .number()
      .int()
      .positive()
      .max(50 * 1024 * 1024),
    mediaType: z
      .string()
      .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/)
      .max(120),
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .refine((value) => !/[\u0000-\u001f\u007f/\\]/u.test(value)),
  })
  .strict();
export type CollectiveMessageAttachment = z.infer<typeof collectiveMessageAttachmentSchema>;

export const collectiveAttachmentScopeSchema = z
  .object({
    serviceInstanceId: z.string().regex(/^svc_[A-Za-z0-9_-]{8,150}$/),
    collectiveId: z.string().regex(/^col_[A-Za-z0-9_-]{8,150}$/),
    humanId: z.string().regex(/^human_[A-Za-z0-9_-]{8,150}$/),
    channelId: z.string().trim().min(1).max(160),
    attachmentId: collectiveMessageAttachmentSchema.shape.attachmentId,
  })
  .strict();
export type CollectiveAttachmentScope = z.infer<typeof collectiveAttachmentScopeSchema>;
export const collectiveStickerScopeSchema = collectiveAttachmentScopeSchema.omit({ attachmentId: true });
export type CollectiveStickerScope = z.infer<typeof collectiveStickerScopeSchema>;
export const collectiveDraftSendReceiptSchema = z
  .object({
    revision: z.number().int().positive().safe(),
    rootEventId: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export const collectiveMessageContentFields = {
  body: z.string().trim().max(32_000),
  attachments: z.array(collectiveMessageAttachmentSchema).min(1).max(12).optional(),
  contextAttachments: z.array(collectiveMessageQuoteSchema).min(1).max(12).optional(),
  richBlocks: z.array(collectiveMessageRichBlockSchema).min(1).max(12).optional(),
};

export function requireCollectiveMessageContent(
  content: {
    body: string;
    attachments?: readonly CollectiveMessageAttachment[];
    contextAttachments?: readonly CollectiveMessageQuote[];
    richBlocks?: readonly CollectiveMessageRichBlock[];
  },
  context: z.RefinementCtx,
) {
  if (
    !content.body &&
    !content.attachments?.length &&
    !content.contextAttachments?.length &&
    !content.richBlocks?.length
  )
    context.addIssue({ code: 'custom', path: ['body'], message: 'A message needs text or content' });
  if (new Set(content.attachments?.map((item) => item.attachmentId)).size !== (content.attachments?.length ?? 0))
    context.addIssue({ code: 'custom', path: ['attachments'], message: 'Duplicate attachment reference' });
  if (new Set(content.contextAttachments?.map((item) => item.id)).size !== (content.contextAttachments?.length ?? 0))
    context.addIssue({ code: 'custom', path: ['contextAttachments'], message: 'Duplicate quote reference' });
  validateCollectiveRichContent(content, context);
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      body: content.body,
      attachments: content.attachments,
      contextAttachments: content.contextAttachments,
      richBlocks: content.richBlocks,
    }),
  ).length;
  if (bytes > 192 * 1024) context.addIssue({ code: 'custom', message: 'Message content exceeds 192 KiB' });
}

/** Rich presentation may describe only the immutable attachments published with this exact message. */
export function validateCollectiveRichContent(
  content: {
    attachments?: readonly CollectiveMessageAttachment[];
    richBlocks?: readonly CollectiveMessageRichBlock[];
  },
  context: z.RefinementCtx,
) {
  requireDistinctRichBlocks(content.richBlocks, context);
  for (const ref of collectiveRichMediaReferences(content.richBlocks ?? [])) {
    const attachment = content.attachments?.find((item) => item.contentRef === ref.url);
    if (!attachment || (ref.kind !== 'file' && !attachment.mediaType.startsWith(`${ref.kind}/`)))
      context.addIssue({
        code: 'custom',
        path: ['richBlocks'],
        message: 'Rich media requires a matching message attachment',
      });
  }
  for (const block of content.richBlocks ?? []) {
    if (block.kind !== 'file') continue;
    const attachment = content.attachments?.find((item) => item.contentRef === block.url);
    if (
      attachment &&
      (block.fileName !== attachment.fileName ||
        (block.fileSize !== undefined && block.fileSize !== attachment.byteLength) ||
        (block.mimeType !== undefined && block.mimeType !== attachment.mediaType))
    )
      context.addIssue({
        code: 'custom',
        path: ['richBlocks'],
        message: 'File description must match retained original metadata',
      });
  }
}
