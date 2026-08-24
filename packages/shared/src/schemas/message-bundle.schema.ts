import { z } from 'zod';
import {
  CONTEXT_ATTACHMENT_COMMENT_MAX_LENGTH,
  CONTEXT_ATTACHMENT_QUOTE_MAX_LENGTH,
} from '../types/context-attachment.js';

export const MESSAGE_BUNDLE_VERSION = 1 as const;
export const MESSAGE_BUNDLE_MAX_ITEMS = 50;
export const MESSAGE_BUNDLE_QUOTE_PROJECTION_VERSION = 1 as const;
export const MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN = 'cat-cafe:message-bundle-quote:v1\0';
/**
 * v2 validates a quote in the readable-text plane the human actually selected in,
 * instead of the raw Markdown plane. v1 carriers stay resolvable forever.
 */
export const MESSAGE_BUNDLE_QUOTE_PROJECTION_VERSION_V2 = 2 as const;
export const MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN_V2 = 'cat-cafe:message-bundle-quote:v2\0';
/** v3 anchors new Markdown quotes in the canonical browser bubble, not one storage row. */
export const MESSAGE_BUNDLE_QUOTE_PROJECTION_VERSION_V3 = 3 as const;
export const MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN_V3 = 'cat-cafe:message-bundle-quote:v3\0';
export const MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION = 1 as const;
export const MESSAGE_BUNDLE_CLI_QUOTE_DIGEST_DOMAIN = 'cat-cafe:message-bundle-cli-quote:v1\0';
/** v2 anchors stdout selected from the Markdown-rendered CLI surface in its readable-text plane. */
export const MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V2 = 2 as const;
export const MESSAGE_BUNDLE_CLI_QUOTE_DIGEST_DOMAIN_V2 = 'cat-cafe:message-bundle-cli-quote:v2\0';
export const MESSAGE_BUNDLE_RICH_BLOCK_PROJECTION_VERSION = 1 as const;
export const MESSAGE_BUNDLE_RICH_BLOCK_DIGEST_DOMAIN = 'cat-cafe:message-bundle-rich-block:v1\0';

const boundedId = z.string().trim().min(1).max(128);
const sourceProjectionSha256 = z.string().regex(/^[a-f0-9]{64}$/);
const characterOffset = z.number().int().nonnegative().max(10_000_000);
const sourceMessageIds = z
  .array(boundedId)
  .min(1)
  .max(MESSAGE_BUNDLE_MAX_ITEMS)
  .superRefine((ids, ctx) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: 'Message Bundle sourceMessageIds must be unique',
        });
      }
      seen.add(id);
    });
  });

function requireAnchorInSourceRefs(
  value: { messageId: string; sourceMessageIds: readonly string[] },
  ctx: z.RefinementCtx,
): void {
  if (!value.sourceMessageIds.includes(value.messageId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceMessageIds'],
      message: 'Message Bundle sourceMessageIds must include messageId',
    });
  }
}

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
    sourceProjectionVersion: z.union([
      z.literal(MESSAGE_BUNDLE_QUOTE_PROJECTION_VERSION),
      z.literal(MESSAGE_BUNDLE_QUOTE_PROJECTION_VERSION_V2),
      z.literal(MESSAGE_BUNDLE_QUOTE_PROJECTION_VERSION_V3),
    ]),
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

export const MessageBundleCliQuoteItemV1Schema = z
  .object({
    kind: z.literal('cli_quote'),
    messageId: boundedId,
    sourceMessageIds,
    segmentId: boundedId,
    selectionStart: characterOffset,
    selectionEnd: characterOffset,
    sourceProjectionVersion: z.union([
      z.literal(MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION),
      z.literal(MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V2),
    ]),
    sourceProjectionSha256,
    comment: z.string().trim().min(1).max(CONTEXT_ATTACHMENT_COMMENT_MAX_LENGTH).optional(),
  })
  .strict()
  .superRefine((quote, ctx) => {
    requireAnchorInSourceRefs(quote, ctx);
    if (
      quote.sourceProjectionVersion === MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V2 &&
      quote.segmentId !== 'stdout'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceProjectionVersion'],
        message: 'CLI readable-text projection is only valid for Markdown-rendered stdout',
      });
    }
    if (quote.selectionEnd <= quote.selectionStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectionEnd'],
        message: 'selectionEnd must be greater than selectionStart',
      });
    }
  });

export const MessageBundleRichBlockItemV1Schema = z
  .object({
    kind: z.literal('rich_block'),
    messageId: boundedId,
    sourceMessageIds,
    blockId: boundedId,
    sourceProjectionVersion: z.literal(MESSAGE_BUNDLE_RICH_BLOCK_PROJECTION_VERSION),
    sourceProjectionSha256,
  })
  .strict()
  .superRefine(requireAnchorInSourceRefs);

export const MessageBundleItemV1Schema = z.union([
  MessageBundleMessageItemV1Schema,
  MessageBundleQuoteItemV1Schema,
  MessageBundleCliQuoteItemV1Schema,
  MessageBundleRichBlockItemV1Schema,
]);

export const MessageBundleSelectionQuoteItemSchema = z
  .object({
    kind: z.literal('quote'),
    messageId: boundedId,
    text: z.string().min(1).max(CONTEXT_ATTACHMENT_QUOTE_MAX_LENGTH),
    selectionStart: characterOffset.optional(),
    selectionEnd: characterOffset.optional(),
    /**
     * How many times the selected characters appear in the *rendered* message, counted by the
     * browser that made the selection. Only the browser can see that plane: the renderer
     * generates text with no source counterpart (footnote labels, KaTeX glyphs, component
     * loading states), so a server-side projection can never prove on-screen uniqueness.
     * Admission requires this to be exactly 1, which is the restrictive direction — a wrong
     * value can only cause a refusal, never a wider anchor.
     */
    renderedOccurrences: z.number().int().min(1).max(10_000).optional(),
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
    if (
      quote.selectionStart !== undefined &&
      quote.selectionEnd !== undefined &&
      quote.selectionEnd <= quote.selectionStart
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectionEnd'],
        message: 'selectionEnd must be greater than selectionStart',
      });
    }
  });

export const MessageBundleSelectionCliQuoteItemSchema = z
  .object({
    kind: z.literal('cli_quote'),
    messageId: boundedId,
    sourceMessageIds,
    segmentId: boundedId,
    text: z.string().min(1).max(CONTEXT_ATTACHMENT_QUOTE_MAX_LENGTH),
    selectionStart: characterOffset,
    selectionEnd: characterOffset,
    /** Omitted means the historical raw-text v1 plane. Markdown-rendered stdout declares v2. */
    sourceProjectionVersion: z.literal(MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V2).optional(),
    renderedOccurrences: z.number().int().min(1).max(10_000).optional(),
    comment: z.string().trim().min(1).max(CONTEXT_ATTACHMENT_COMMENT_MAX_LENGTH).optional(),
  })
  .strict()
  .superRefine((quote, ctx) => {
    requireAnchorInSourceRefs(quote, ctx);
    if (
      quote.sourceProjectionVersion === MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V2 &&
      quote.segmentId !== 'stdout'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceProjectionVersion'],
        message: 'CLI readable-text projection is only valid for Markdown-rendered stdout',
      });
    }
    if (quote.selectionEnd <= quote.selectionStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectionEnd'],
        message: 'selectionEnd must be greater than selectionStart',
      });
    }
  });

export const MessageBundleSelectionRichBlockItemSchema = z
  .object({
    kind: z.literal('rich_block'),
    messageId: boundedId,
    sourceMessageIds,
    blockId: boundedId,
  })
  .strict()
  .superRefine(requireAnchorInSourceRefs);

export const MessageBundleSelectionItemSchema = z.union([
  MessageBundleMessageItemV1Schema,
  MessageBundleSelectionQuoteItemSchema,
  MessageBundleSelectionCliQuoteItemSchema,
  MessageBundleSelectionRichBlockItemSchema,
]);

type MessageBundleIdentityItem =
  | { kind: 'message' | 'quote'; messageId: string }
  | {
      kind: 'cli_quote';
      messageId: string;
      segmentId: string;
      selectionStart: number;
      selectionEnd: number;
    }
  | { kind: 'rich_block'; messageId: string; blockId: string };

export function messageBundleItemIdentity(item: MessageBundleIdentityItem): string {
  if (item.kind === 'cli_quote') {
    return `cli_quote:${item.messageId}:${item.segmentId}:${item.selectionStart}:${item.selectionEnd}`;
  }
  if (item.kind === 'rich_block') return `rich_block:${item.messageId}:${item.blockId}`;
  return `message-content:${item.messageId}`;
}

function addDuplicateItemIssues(items: readonly MessageBundleIdentityItem[], ctx: z.RefinementCtx): void {
  const seenItems = new Set<string>();
  items.forEach((item, index) => {
    const identity = messageBundleItemIdentity(item);
    if (seenItems.has(identity)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items', index],
        message: 'Message Bundle items must have unique identities',
      });
    }
    seenItems.add(identity);
  });
}

export const MessageBundleSelectionSchema = z
  .object({
    sourceThreadId: boundedId,
    note: z.string().trim().min(1).max(CONTEXT_ATTACHMENT_COMMENT_MAX_LENGTH).optional(),
    items: z.array(MessageBundleSelectionItemSchema).min(1).max(MESSAGE_BUNDLE_MAX_ITEMS),
  })
  .strict()
  .superRefine((selection, ctx) => addDuplicateItemIssues(selection.items, ctx));

export const MessageBundleCarrierV1Schema = z
  .object({
    v: z.literal(MESSAGE_BUNDLE_VERSION),
    sourceThreadId: boundedId,
    note: z.string().trim().min(1).max(CONTEXT_ATTACHMENT_COMMENT_MAX_LENGTH).optional(),
    items: z.array(MessageBundleItemV1Schema).min(1).max(MESSAGE_BUNDLE_MAX_ITEMS),
  })
  .strict()
  .superRefine((carrier, ctx) => addDuplicateItemIssues(carrier.items, ctx));

export type MessageBundleMessageItemV1 = z.infer<typeof MessageBundleMessageItemV1Schema>;
export type MessageBundleQuoteItemV1 = z.infer<typeof MessageBundleQuoteItemV1Schema>;
export type MessageBundleCliQuoteItemV1 = z.infer<typeof MessageBundleCliQuoteItemV1Schema>;
export type MessageBundleRichBlockItemV1 = z.infer<typeof MessageBundleRichBlockItemV1Schema>;
export type MessageBundleItemV1 = z.infer<typeof MessageBundleItemV1Schema>;
export type MessageBundleCarrierV1 = z.infer<typeof MessageBundleCarrierV1Schema>;
export type MessageBundleSelectionQuoteItem = z.infer<typeof MessageBundleSelectionQuoteItemSchema>;
export type MessageBundleSelectionCliQuoteItem = z.infer<typeof MessageBundleSelectionCliQuoteItemSchema>;
export type MessageBundleSelectionRichBlockItem = z.infer<typeof MessageBundleSelectionRichBlockItemSchema>;
export type MessageBundleSelectionItem = z.infer<typeof MessageBundleSelectionItemSchema>;
export type MessageBundleSelection = z.infer<typeof MessageBundleSelectionSchema>;
