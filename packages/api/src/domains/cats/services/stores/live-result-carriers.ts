import { z } from 'zod';

const reference = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/\p{Cc}/u.test(value));
const references = z.array(reference).max(32);
/** Host-written presentation qualification, never execution authority or proof of playback. */
export const liveReturnProjectionSchema = z
  .object({
    presentationEligibility: z.enum(['current', 'deferred']),
    requestRefs: references,
    reminderForMessageIds: references.optional(),
  })
  .strict();

/** Durable facts owned by the original Live Message ledger; unknown payloads remain unrecognized. */
export const liveResultNoticeSchema = z.discriminatedUnion('phase', [
  z
    .object({
      kind: z.literal('live_result_notice'),
      phase: z.literal('deferred'),
      resultMessageId: reference,
      requestRefs: references.min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('live_result_notice'),
      phase: z.literal('reminder_committed'),
      resultMessageId: reference,
      requestRefs: references,
      reminderMessageId: reference,
    })
    .strict(),
]);
