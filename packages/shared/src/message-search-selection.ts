import { z } from 'zod';

const id = z.string().min(1).max(2048);
const offset = z.number().int().nonnegative();
export const messageSourcePartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('body') }).strict(),
  z.object({ kind: z.enum(['text', 'code', 'quote', 'comment']), blockIndex: offset }).strict(),
]);
export type MessageSourcePart = z.infer<typeof messageSourcePartSchema>;

/** Caller supplies evidence locators, never a publisher/author/permission grant. */
export const selectedMessageSourceSchema = z
  .object({
    threadId: id,
    messageId: id,
    contentRevision: z.string().regex(/^[a-f0-9]{64}$/),
    quote: z
      .string()
      .min(1)
      .max(1000)
      .refine((value) => value.trim().length > 0),
    reason: z.string().trim().min(1).max(1000),
    part: messageSourcePartSchema.optional(),
    range: z.object({ start: offset, end: offset }).strict().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.range && (!value.part || value.range.end <= value.range.start))
      ctx.addIssue({ code: 'custom', message: 'An explicit range requires its exact source part and end > start.' });
  });
export type SelectedMessageSource = z.infer<typeof selectedMessageSourceSchema>;

export const selectedMessageSourcesSchema = z
  .array(selectedMessageSourceSchema)
  .min(1)
  .max(20)
  .superRefine((rows, ctx) => {
    const seen = new Set<string>();
    rows.forEach((row, index) => {
      const key = JSON.stringify([row.threadId, row.messageId]);
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: [index], message: 'Select each source message once.' });
      seen.add(key);
    });
  });

const bounded = z.string().max(2400);
const headings = z.array(z.string().max(300)).max(6);
export const selectedSourceOriginSchema = z.object({
  threadId: id,
  messageId: id,
  contentRevision: id,
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  speaker: id,
  speakerLabel: bounded.optional(),
  timestamp: z.number().finite(),
  headingPath: headings,
});

/** Only Host constructs this receipt; the publication digest binds it to the actual message. */
export const messageSourceSelectionSchema = z.object({
  v: z.literal(1),
  reason: z.string().min(1).max(1000),
  quote: z.string().min(1).max(1000),
  part: messageSourcePartSchema,
  range: z.object({ start: offset, end: offset }),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  context: z.object({
    text: bounded,
    start: offset,
    end: offset,
    quoteStart: offset,
    quoteEnd: offset,
    truncatedBefore: z.boolean(),
    truncatedAfter: z.boolean(),
  }),
  headingPath: headings,
  quotation: z
    .object({
      text: bounded,
      truncated: z.boolean(),
      origin: selectedSourceOriginSchema.optional(),
    })
    .optional(),
  comment: z.object({ text: bounded, truncated: z.boolean() }).optional(),
});
export type MessageSourceSelection = z.infer<typeof messageSourceSelectionSchema>;

export const messageAnswerSelectionSchema = z.object({
  v: z.literal(1),
  catId: id,
  requested: z.number().int().min(1).max(20),
});
export type MessageAnswerSelection = z.infer<typeof messageAnswerSelectionSchema>;
