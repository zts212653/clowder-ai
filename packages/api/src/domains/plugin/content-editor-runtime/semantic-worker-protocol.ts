import { z } from 'zod';

// Host transport shape and resource bounds for the existing editor worker v1.
// Format parsing, anchor interpretation and text/attribution codec rules belong
// to the provider. No Host authority or filesystem locator crosses this wire.
const bytes = z
  .string()
  .min(4)
  .max(11184812)
  .refine((value) => {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length <= 8 * 1024 * 1024 && decoded.toString('base64') === value;
  });
const anchor = z.object({ paragraphId: z.string().min(1).max(128), textQuote: z.string().min(1).max(8192) }).strict();
const attribution = z
  .object({
    author: z.string().min(1).max(64),
    operationId: z.string().min(1).max(128),
    timestamp: z.string().min(1).max(64),
  })
  .strict();
const operation = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('inspect'),
      cursor: z.number().int().min(0).max(65535),
      limit: z.number().int().min(1).max(32),
    })
    .strict(),
  z
    .object({ kind: z.literal('tracked-change'), target: anchor, replacement: z.string().max(8192), attribution })
    .strict(),
  z.object({ kind: z.literal('comment'), target: anchor, body: z.string().min(1).max(8192), attribution }).strict(),
]);
export const editorWorkerRequest = z
  .object({
    protocolVersion: z.literal('1.0.0'),
    requestId: z.string().min(1).max(128),
    mediaType: z.string().min(1).max(256),
    bytesBase64: bytes,
    operation,
  })
  .strict();
export const editorWorkerResponse = z
  .object({
    protocolVersion: z.literal('1.0.0'),
    requestId: z.string().min(1).max(128),
    result: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('inspection'),
          paragraphs: z.array(z.object({ target: anchor, editable: z.boolean() }).strict()).max(32),
          nextCursor: z.number().int().min(0).max(65535).nullable(),
        })
        .strict(),
      z.object({ kind: z.literal('document'), bytesBase64: bytes }).strict(),
      // Existing port rejection values are transported, never interpreted as
      // evidence that the Host understands the provider's document format.
      z
        .object({
          kind: z.literal('rejected'),
          code: z.enum(['TARGET_MISMATCH', 'UNSUPPORTED_TARGET', 'INVALID_DOCX', 'LIMIT_EXCEEDED', 'INVALID_REQUEST']),
        })
        .strict(),
    ]),
  })
  .strict();
export type EditorWorkerRequest = z.infer<typeof editorWorkerRequest>;
