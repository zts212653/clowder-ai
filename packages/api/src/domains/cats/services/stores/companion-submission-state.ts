import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { StoredMessage } from './ports/MessageStore.js';

export const companionDraftSubmissionSchema = z
  .object({
    clientMessageId: z.string().uuid(),
    text: z.string().trim().min(1).max(8000),
    callId: z.string().uuid().nullable(),
    submissionRevision: z.number().int().nonnegative(),
    reservationRevision: z.number().int().positive(),
    createdAt: z.number().finite().nonnegative(),
  })
  .strict();
export type CompanionDraftSubmission = z.infer<typeof companionDraftSubmissionSchema>;
export const companionDraftSubmissionsSchema = z
  .array(companionDraftSubmissionSchema)
  .max(32)
  .refine((rows) => new Set(rows.map((row) => row.clientMessageId)).size === rows.length);
export function readCompanionDraftSubmissions(value: unknown): CompanionDraftSubmission[] {
  const parsed = companionDraftSubmissionsSchema.safeParse(value);
  if (!parsed.success) throw new Error('Companion submission history unavailable');
  return parsed.data;
}
const internalIdentity = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\s\u0000-\u001f]+$/);
export const companionDeliveryReceiptSchema = z
  .object({
    clientMessageId: internalIdentity,
    callId: internalIdentity.nullable(),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    acceptedAt: z.number().finite().nonnegative(),
  })
  .strict();
// Native Host identities predate the public UUID wire; only wire-compatible facts may be projected.
export const publicCompanionDeliveryReceiptSchema = companionDeliveryReceiptSchema.extend({
  clientMessageId: z.string().uuid(),
  callId: z.string().uuid().nullable(),
});
export type StoredCompanionDeliveryReceipt = z.infer<typeof companionDeliveryReceiptSchema>;
export type CompanionDeliveryAcceptance = StoredCompanionDeliveryReceipt & { ownerUserId: string; threadId: string };
export const companionTextDigest = (text: string) => createHash('sha256').update(text).digest('hex');
export const companionSubmissionKey = (input: { callId: string | null; clientMessageId: string }) =>
  input.callId === null ? input.clientMessageId : `live-text:${input.callId}:${input.clientMessageId}`;
export function readStoredCompanionDelivery(raw: string | undefined): StoredCompanionDeliveryReceipt | undefined {
  if (!raw) return;
  try {
    const parsed = companionDeliveryReceiptSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return;
  }
}
/** A receipt is admissible only beside its original, unchanged user body and transport identity. */
export function companionDeliveryMatches(message: StoredMessage, receipt: StoredCompanionDeliveryReceipt): boolean {
  if (
    message.catId !== null ||
    message.from?.kind !== 'user' ||
    message.from.userId !== message.userId ||
    message.source ||
    message.recall ||
    message.deletedAt ||
    message._tombstone ||
    companionTextDigest(message.content) !== receipt.contentDigest
  )
    return false;
  const live = message.extra?.liveCompanion;
  return receipt.callId === null
    ? live === undefined
    : live?.modality === 'typed' && live.callId === receipt.callId && live.clientMessageId === receipt.clientMessageId;
}
