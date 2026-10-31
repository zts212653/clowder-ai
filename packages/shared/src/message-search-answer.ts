import { z } from 'zod';
import type { MessageSearchResponse } from './message-search.js';

const text = z.string().max(24000);
const id = z.string().min(1).max(2048);
const count = z.number().int().nonnegative();
const mode = z.enum(['lexical', 'semantic', 'hybrid']);
export const messageSearchResponseSchema = z.object({
  searchId: id,
  query: z.string().max(2000),
  results: z
    .array(
      z.object({
        threadId: id,
        messageId: id,
        threadTitle: text,
        speaker: id,
        speakerLabel: text.optional(),
        timestamp: z.number().finite(),
        timelineOrderAt: z.number().finite(),
        snippet: z.object({ text, start: count, end: count, source: z.enum(['body', 'attachment-text']) }),
        highlights: z.array(z.object({ start: count, end: count })).max(200),
        match: mode,
        contentRevision: id,
        publiclyQuotable: z.boolean(),
        decisionSources: z
          .array(
            z.object({
              status: z.enum(['decided', 'not-adopted', 'superseded']),
              conclusion: text,
              featureId: id,
              documentPath: id,
              documentRevision: id,
              line: count,
              decidedBy: text.optional(),
              decidedAt: text.optional(),
              historical: z.boolean().optional(),
            }),
          )
          .max(200)
          .optional(),
      }),
    )
    .max(20),
  meta: z.object({
    scope: z.enum(['thread', 'global']),
    threadId: id.optional(),
    sort: z.enum(['time', 'relevance']),
    requestedMode: mode,
    effectiveMode: mode,
    degraded: z.boolean(),
    degradeReason: text.optional(),
    partial: z.boolean(),
    hasMore: z.boolean(),
    candidateLimit: count,
    semanticCandidatesLimited: z.boolean(),
    sourceCoverage: z.literal('unknown'),
    freshness: z.literal('unknown'),
    decisionIndex: z.object({ status: z.enum(['ready', 'unavailable']), revision: id.optional() }).optional(),
    qualification: z
      .object({
        status: z.enum(['complete', 'partial']),
        examined: count,
        supported: count,
        rejected: count,
        indeterminate: count,
        unassessed: count,
      })
      .optional(),
    response: z.object({
      budgetChars: count,
      serializedChars: count,
      truncated: z.boolean(),
      continuation: z.literal('unavailable'),
    }),
  }),
});

/** A ref is a locator, never proof that a result was published. */
export const messageSearchAnswerRefSchema = z.string().regex(/^message-search-answer:[a-f0-9]{64}$/);
export const messageSearchAnswerBindingSchema = z.object({
  v: z.literal(1),
  publicationRef: messageSearchAnswerRefSchema,
  blockId: z.string().min(1).max(128),
  responseDigest: z.string().regex(/^[a-f0-9]{64}$/),
  forwardedFromMessageId: z.string().min(1).max(256).optional(),
});
export type MessageSearchAnswerBinding = z.infer<typeof messageSearchAnswerBindingSchema>;
export const messageSearchAnswerAttachmentSchema = z.object({
  publicationRef: messageSearchAnswerRefSchema,
  /** Explicit forward of an actual server-bound card, never a copied permission grant. */
  source: z.object({ messageId: z.string().min(1).max(256), blockId: z.string().min(1).max(128) }).optional(),
});
export type MessageSearchAnswerAttachmentRequest = z.infer<typeof messageSearchAnswerAttachmentSchema>;
export interface MessageSearchAnswerView {
  status: 'available' | 'unavailable';
  publicationRef?: string;
  response?: MessageSearchResponse;
  createdAt?: number;
  changedSources?: number;
  decisionUpdated?: boolean;
}
