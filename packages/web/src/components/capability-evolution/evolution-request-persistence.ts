import { z } from 'zod';

/** One invalid request cannot erase independent idempotency keys or delivery receipts. */
export function recoverRequestRecords<T>(persisted: unknown, schema: z.ZodType<T>): Record<string, T> | undefined {
  const parsed = z.object({ records: z.record(z.string(), z.unknown()) }).safeParse(persisted);
  if (!parsed.success) return undefined;
  return Object.fromEntries(
    Object.entries(parsed.data.records).flatMap(([key, value]) => {
      // A request is atomic: never assemble its target or message id from another record.
      const record = schema.safeParse(value);
      return record.success ? [[key, record.data]] : [];
    }),
  );
}
