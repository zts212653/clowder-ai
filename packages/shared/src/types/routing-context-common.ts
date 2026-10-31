import { z } from 'zod';

export const ROUTING_CONTEXT_VERSION = 1 as const;

export const routingIdentifierSchema = z.string().trim().min(1).max(200);
export const routingOwnerIdSchema = z.string().trim().min(1).max(120);
export const routingReferenceSchema = z.string().trim().min(1).max(500);
export const routingSummarySchema = z.string().trim().min(1).max(1_000);
export const routingEpochMsSchema = z.number().int().finite().nonnegative();

export function addRoutingDuplicateIssues(
  values: readonly string[],
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index],
        message: 'duplicate values are not allowed',
      });
    }
    seen.add(value);
  });
}
