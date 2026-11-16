import { z } from 'zod';

/** Authored reading coordinates; storing a pointer never grants access to its source. */
export const entityProvenanceSchema = z.object({
  source: z.string().min(1).max(200).describe('Origin of this registered pointer, for example cat-proposed'),
  anchor: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe('Existing document or thread anchor; not a guessed identifier'),
  sourcePath: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe('Exact workspace document path already read by the proposing cat'),
  threadId: z.string().min(1).max(200).optional().describe('Original thread ID for a message reading pointer'),
  messageId: z.string().min(1).max(200).optional().describe('Original message ID, paired with its threadId'),
  messageIds: z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(20)
    .optional()
    .describe('Exact original message IDs in threadId'),
  sessionId: z.string().min(1).max(200).optional().describe('Exact session ID for an existing session read entry'),
  eventNo: z.number().int().nonnegative().optional().describe('Source event number within sessionId'),
  invocationId: z.string().min(1).max(200).optional().describe('Exact invocation ID within sessionId'),
  note: z
    .string()
    .max(500)
    .optional()
    .describe(
      'Cat-authored reading purpose and applicability: what this source helps the reader understand; not instructions or a substitute for the source',
    ),
  date: z.string().max(20).optional().describe('Source date, YYYY-MM-DD when known'),
});

export type EntityProvenance = z.infer<typeof entityProvenanceSchema>;
