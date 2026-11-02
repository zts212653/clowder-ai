import { z } from 'zod';

export const boundedId = z.string().trim().min(1).max(128);
export const boundedPath = z.string().trim().min(1).max(4096);
export const boundedMetadata = z.string().trim().min(1).max(512);
export const ownerRevision = z.string().regex(/^sha256:[a-f0-9]{64}$/) as z.ZodType<`sha256:${string}`>;
export const lineNumber = z.number().int().positive().max(10_000_000);
export const characterOffset = z.number().int().nonnegative().max(10_000_000);

export function withValidLineRange<T extends z.ZodRawShape>(shape: T) {
  return z
    .object(shape)
    .strict()
    .refine(
      (value) => value.lineStart === undefined || value.lineEnd === undefined || value.lineEnd >= value.lineStart,
      {
        message: 'lineEnd must be greater than or equal to lineStart',
        path: ['lineEnd'],
      },
    );
}
