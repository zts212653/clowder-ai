import { z } from 'zod';
import {
  CONTEXT_ATTACHMENT_COMMENT_MAX_LENGTH,
  CONTEXT_ATTACHMENT_QUOTE_MAX_LENGTH,
} from '../types/context-attachment.js';

export const MESSAGE_BUNDLE_VERSION = 1 as const;
export const MESSAGE_BUNDLE_MAX_ITEMS = 50;
export const MESSAGE_BUNDLE_QUOTE_PROJECTION_VERSION = 1 as const;
export const MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN = 'cat-cafe:message-bundle-quote:v1\0';

const boundedId = z.string().trim().min(1).max(128);
const sourceProjectionSha256 = z.string().regex(/^[a-f0-9]{64}$/);
const characterOffset = z.number().int().nonnegative().max(10_000_000);

export const MessageBundleMessageItemV1Schema = z
  .object({
    kind: z.literal('message'),
    messageId: boundedId,
  })
  .strict();

export const MessageBundleQuoteItemV1Schema = z
  .object({
    kind: z.literal('quote'),
    messageId: boundedId,
    selectionStart: characterOffset,
    selectionEnd: characterOffset,
    sourceProjectionVersion: z.literal(MESSAGE_BUNDLE_QUOTE_PROJECTION_VERSION),
    sourceProjectionSha256,
    comment: z.string().trim().min(1).max(CONTEXT_ATTACHMENT_COMMENT_MAX_LENGTH).optional(),
  })
  .strict()
  .superRefine((quote, ctx) => {
    if (quote.selectionEnd <= quote.selectionStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectionEnd'],
        message: 'selectionEnd must be greater than selectionStart',
      });
    }
  });

export const MessageBundleItemV1Schema = z.union([MessageBundleMessageItemV1Schema, MessageBundleQuoteItemV1Schema]);

export const MessageBundleSelectionQuoteItemSchema = z
  .object({
    kind: z.literal('quote'),
    messageId: boundedId,
    text: z.string().min(1).max(CONTEXT_ATTACHMENT_QUOTE_MAX_LENGTH),
    selectionStart: characterOffset.optional(),
    selectionEnd: characterOffset.optional(),
    comment: z.string().trim().min(1).max(CONTEXT_ATTACHMENT_COMMENT_MAX_LENGTH).optional(),
  })
  .strict()
  .superRefine((quote, ctx) => {
    const hasStart = quote.selectionStart !== undefined;
    const hasEnd = quote.selectionEnd !== undefined;
    if (hasStart !== hasEnd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: hasStart ? ['selectionEnd'] : ['selectionStart'],
        message: 'selectionStart and selectionEnd must be provided together',
      });
      return;
    }
    if (hasStart && hasEnd && quote.selectionEnd! <= quote.selectionStart!) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectionEnd'],
        message: 'selectionEnd must be greater than selectionStart',
      });
    }
  });

export const MessageBundleSelectionItemSchema = z.union([
  MessageBundleMessageItemV1Schema,
  MessageBundleSelectionQuoteItemSchema,
]);

function addDuplicateMessageIdIssues(items: readonly { messageId: string }[], ctx: z.RefinementCtx): void {
  const seenMessageIds = new Set<string>();
  items.forEach((item, index) => {
    if (seenMessageIds.has(item.messageId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items', index, 'messageId'],
        message: 'Message Bundle items must have unique messageId values',
      });
    }
    seenMessageIds.add(item.messageId);
  });
}

export const MessageBundleSelectionSchema = z
  .object({
    sourceThreadId: boundedId,
    items: z.array(MessageBundleSelectionItemSchema).min(1).max(MESSAGE_BUNDLE_MAX_ITEMS),
  })
  .strict()
  .superRefine((selection, ctx) => addDuplicateMessageIdIssues(selection.items, ctx));

export const MessageBundleCarrierV1Schema = z
  .object({
    v: z.literal(MESSAGE_BUNDLE_VERSION),
    sourceThreadId: boundedId,
    items: z.array(MessageBundleItemV1Schema).min(1).max(MESSAGE_BUNDLE_MAX_ITEMS),
  })
  .strict()
  .superRefine((carrier, ctx) => addDuplicateMessageIdIssues(carrier.items, ctx));

export type MessageBundleMessageItemV1 = z.infer<typeof MessageBundleMessageItemV1Schema>;
export type MessageBundleQuoteItemV1 = z.infer<typeof MessageBundleQuoteItemV1Schema>;
export type MessageBundleItemV1 = z.infer<typeof MessageBundleItemV1Schema>;
export type MessageBundleCarrierV1 = z.infer<typeof MessageBundleCarrierV1Schema>;
export type MessageBundleSelectionQuoteItem = z.infer<typeof MessageBundleSelectionQuoteItemSchema>;
export type MessageBundleSelectionItem = z.infer<typeof MessageBundleSelectionItemSchema>;
export type MessageBundleSelection = z.infer<typeof MessageBundleSelectionSchema>;
