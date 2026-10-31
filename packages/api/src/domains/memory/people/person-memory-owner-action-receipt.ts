import { z } from 'zod';
import type { OwnerMemoryActionAppliedProjection } from './person-memory-owner-action-contract.js';

export const ownerActionReceiptSchema = z
  .object({
    v: z.literal(1),
    ownerUserId: z.string().min(1).max(200),
    requestId: z.string().min(1).max(200),
    requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    action: z.enum(['correct_claim', 'retire_claim', 'amend_event']),
    itemId: z.string().min(1).max(200),
    revision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    completedAt: z.number().int().nonnegative(),
  })
  .strict();

export type OwnerActionReceipt = z.infer<typeof ownerActionReceiptSchema>;

export function parseOwnerActionReceipt(raw: string): OwnerActionReceipt {
  return ownerActionReceiptSchema.parse(JSON.parse(raw));
}

export function projectOwnerActionReceipt(
  receipt: OwnerActionReceipt,
  outcome: 'applied' | 'replayed',
): OwnerMemoryActionAppliedProjection {
  return {
    action: receipt.action,
    outcome,
    itemId: receipt.itemId,
    revision: receipt.revision,
  };
}
