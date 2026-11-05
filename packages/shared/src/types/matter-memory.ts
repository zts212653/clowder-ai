import { z } from 'zod';
import type { MessageFrom } from './message-lifecycle.js';

const id = z.string().trim().min(1).max(200);
const revision = z.number().int().positive();

/** Offsets address raw UTF-16 text, never a normalized search passage. */
export const matterSourceInputSchema = z
  .object({
    threadId: id.describe('Exact source thread ID.'),
    messageId: id.describe('Exact source message ID in that thread.'),
    segment: z
      .enum(['body', 'quote_comment', 'quote_text'])
      .describe('Raw message body, the quoting author comment, or quoted text; never normalized search text.'),
    contentBlockIndex: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Zero-based contentBlocks index; required for quote segments or multiple text blocks.'),
    attachmentId: id.optional().describe('Exact quote attachment ID; required for quote segments.'),
    start: z.number().int().nonnegative().describe('Inclusive raw UTF-16 offset within the selected segment.'),
    end: z.number().int().positive().describe('Exclusive raw UTF-16 offset, greater than start.'),
    quote: z
      .string()
      .min(1)
      .max(8000)
      .describe('Exact selected original text, preserving whitespace; maximum 8000 UTF-16 units.'),
  })
  .strict()
  .refine((source) => source.end > source.start, 'end must follow start');
export type MatterSourceInput = z.infer<typeof matterSourceInputSchema>;

const writeBase = { requestId: id };
const existing = { ...writeBase, matterId: id, expectedRevision: revision };
export const matterWriteInputSchema = z.discriminatedUnion('operation', [
  z
    .object({
      ...writeBase,
      operation: z.literal('create'),
      title: z.string().trim().min(1).max(160),
      description: z.string().max(4000).default(''),
      sources: z.array(matterSourceInputSchema).min(1).max(30),
    })
    .strict(),
  z
    .object({ ...existing, operation: z.literal('append'), sources: z.array(matterSourceInputSchema).min(1).max(30) })
    .strict(),
  z
    .object({
      ...existing,
      operation: z.literal('edit'),
      title: z.string().trim().min(1).max(160),
      description: z.string().max(4000),
    })
    .strict(),
  z.object({ ...existing, operation: z.literal('correct'), entryId: id, source: matterSourceInputSchema }).strict(),
  z.object({ ...existing, operation: z.literal('retire_entry'), entryId: id }).strict(),
  z.object({ ...existing, operation: z.literal('retire') }).strict(),
  z.object({ ...existing, operation: z.literal('forget') }).strict(),
]);
export type MatterWriteInput = z.infer<typeof matterWriteInputSchema>;

export interface MatterSourceCoordinate extends Omit<MatterSourceInput, 'quote'> {
  sourceRevision: string;
  author: MessageFrom;
  timestamp: number;
}
export interface MemoryMatter {
  matterId: string;
  title: string;
  description: string;
  revision: number;
  status: 'active' | 'retired';
  createdAt: number;
  updatedAt: number;
}
export interface MatterEntryView {
  entryId: string;
  status: 'active' | 'superseded' | 'retired';
  supersededBy?: string;
  source: MatterSourceCoordinate;
  sourceStatus: 'current' | 'changed';
  quote?: string;
  /** A quote's outer speaker is not its quoted speaker. */
  attribution: 'author' | 'quoted_in_message';
  verifiedQuotedAuthor?: MessageFrom;
}
export interface MatterPage {
  matter: MemoryMatter;
  entries: MatterEntryView[];
  /** An active original changed; the stored interpretation has not been reverified. */
  summaryStatus?: 'sources_changed';
  nextCursor?: string;
}
export interface MatterCatalogItem extends MemoryMatter {
  entryCount: number;
  /** A currently readable, active, unchanged source originates in this thread; not applicability. */
  hasThreadSource?: boolean;
  summaryStatus?: 'sources_changed';
}
export interface MatterUnavailableItem {
  matterId: string;
  revision: number;
  unavailable: true;
  status: 'active' | 'retired';
}
export interface MatterCatalog {
  items: Array<MatterCatalogItem | MatterUnavailableItem>;
  nextCursor?: string;
}
export interface MatterMutationReceipt {
  outcome: 'applied' | 'forgotten';
  matter: { matterId: string; revision: number; status: 'active' | 'retired' };
}

/** Content-free read evidence; only the matter resolver may carry this shape. */
export const matterReadDetailsSchema = z
  .object({
    matterId: id,
    pageRevision: revision,
    entries: z
      .array(z.object({ entryId: id, sourceRevision: id }).strict())
      .min(1)
      .max(1000),
  })
  .strict();
export type MatterReadDetails = z.infer<typeof matterReadDetailsSchema>;
export type MatterReadSummary =
  | { status: 'current'; matterId: string; title: string; messageCount: number }
  | { status: 'changed'; matterId: string }
  | { status: 'not_available' };
