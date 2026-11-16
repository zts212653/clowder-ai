import { z } from 'zod';
import type { ReadRef } from './memory-read.js';
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

/** A return address, not a claim that a sentence was checked against the original. */
export const matterSourcePointerInputSchema = z
  .object({
    threadId: id,
    messageId: id.optional(),
  })
  .strict();
export type MatterSourcePointerInput = z.infer<typeof matterSourcePointerInputSchema>;
export const matterWriteSourceInputSchema = z.union([matterSourceInputSchema, matterSourcePointerInputSchema]);
export type MatterWriteSourceInput = z.infer<typeof matterWriteSourceInputSchema>;
const summary = z
  .string()
  .trim()
  .min(1)
  .max(4000)
  .optional()
  .describe('Your interpretation, not a verbatim quotation. The authenticated writer is recorded by the server.');
const sources = z
  .array(matterWriteSourceInputSchema)
  .min(1)
  .max(30)
  .optional()
  .describe(
    'Optional thread/message return addresses or exact quotations. If omitted, the server binds this real invocation thread and any confirmed triggering message.',
  );

const writeBase = { requestId: id };
const existing = { ...writeBase, matterId: id, expectedRevision: revision };
export const matterWriteInputSchema = z.discriminatedUnion('operation', [
  z
    .object({
      ...writeBase,
      operation: z.literal('create'),
      title: z.string().trim().min(1).max(160),
      description: z.string().max(4000).default(''),
      summary,
      sources,
    })
    .strict(),
  z.object({ ...existing, operation: z.literal('append'), summary, sources }).strict(),
  z
    .object({
      ...existing,
      operation: z.literal('edit'),
      title: z.string().trim().min(1).max(160),
      description: z.string().max(4000),
    })
    .strict(),
  z
    .object({
      ...existing,
      operation: z.literal('correct'),
      entryId: id,
      summary,
      source: matterWriteSourceInputSchema.optional(),
    })
    .strict(),
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
export type MatterSourcePointer =
  | { kind: 'thread'; threadId: string; origin: 'explicit' | 'invocation' }
  | {
      kind: 'message';
      threadId: string;
      messageId: string;
      origin: 'explicit' | 'invocation';
      author: MessageFrom;
      timestamp: number;
      sourceRevision: string;
      contentRevision: string;
    };
export type MatterSourceReference = MatterSourceCoordinate | MatterSourcePointer;
export interface MemoryMatter {
  matterId: string;
  title: string;
  description: string;
  /** Absent on historical records; never infer it from an original message's speaker. */
  descriptionAuthor?: MessageFrom;
  revision: number;
  status: 'active' | 'retired';
  createdAt: number;
  updatedAt: number;
}
export interface MatterEntryView {
  readRef?: ReadRef;
  entryId: string;
  status: 'active' | 'superseded' | 'retired';
  supersededBy?: string;
  source: MatterSourceReference;
  sourceStatus: 'current' | 'changed' | 'thread_only';
  summary?: string;
  summaryAuthor?: MessageFrom;
  recordedAt?: number;
  /** The entry as received; separate from any original-message revision. */
  entryRevision?: string;
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
  readRef?: ReadRef;
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
  writeRef?: MatterWriteRef;
}

/** Content-free address of the original durable write receipt, never a live page preview. */
export const matterWriteRefSchema = z
  .object({
    actorKey: id,
    requestId: id,
    operation: z.enum(['create', 'append', 'edit', 'correct', 'retire_entry', 'retire', 'forget']),
    revision,
  })
  .strict();
export type MatterWriteRef = z.infer<typeof matterWriteRefSchema>;
export interface MatterWriteSnapshot {
  operation: MatterWriteRef['operation'];
  matter: Pick<MemoryMatter, 'matterId' | 'title' | 'revision'>;
  recordedAt: number;
  writer?: MessageFrom;
  titleChange?: { before: string; after: string };
  descriptionChange?: { before: string; after: string; author?: MessageFrom };
  entries: MatterEntryView[];
  previousEntries?: MatterEntryView[];
  /** Current validity warning only; fixed write content is never replaced with today's page. */
  sourcesChanged?: boolean;
}

/** Content-free read evidence; only the matter resolver may carry this shape. */
export const matterReadDetailsSchema = z
  .object({
    matterId: id,
    pageRevision: revision,
    entries: z
      .array(
        z.union([
          z.object({ entryId: id, sourceRevision: id }).strict(),
          z.object({ entryId: id, entryRevision: id }).strict(),
        ]),
      )
      .min(1)
      .max(1000),
  })
  .strict();
export type MatterReadDetails = z.infer<typeof matterReadDetailsSchema>;
export type MatterReadSummary =
  | { status: 'current'; matterId: string; title: string; messageCount: number; summaryCount?: number }
  | { status: 'changed'; matterId: string }
  | { status: 'not_available' };
