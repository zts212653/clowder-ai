import { z } from 'zod';

const publicId = (prefix: string) =>
  z
    .string()
    .min(prefix.length + 8)
    .max(160)
    .regex(new RegExp(`^${prefix}[A-Za-z0-9_-]+$`));
const catId = z.string().trim().min(1).max(120);

/** Host claim, checked against the current Work before the Service issues a receipt. */
export const collectiveWorkResultIntentSchema = z
  .object({
    assignmentEventId: publicId('evt_'),
    assignmentCatId: catId.optional(),
    participationRevision: z.number().int().positive(),
    resultRevision: z.number().int().positive(),
    executionRevision: z.number().int().positive().optional(),
  })
  .strict();
const author = {
  workId: publicId('work_'),
  connectionId: publicId('con_'),
  humanId: publicId('human_'),
  catId,
};
export const collectiveWorkResultReceiptSchema = collectiveWorkResultIntentSchema.extend(author).strict();
/** Progress is scoped to the current execution and result round, but creates no result. */
export const collectiveWorkProgressIntentSchema = collectiveWorkResultIntentSchema
  .extend({
    executionRevision: z.number().int().positive(),
  })
  .strict();
export const collectiveWorkProgressReceiptSchema = collectiveWorkProgressIntentSchema.extend(author).strict();
export type CollectiveWorkResultIntent = z.infer<typeof collectiveWorkResultIntentSchema>;
export type CollectiveWorkResultReceipt = z.infer<typeof collectiveWorkResultReceiptSchema>;
export type CollectiveWorkProgressIntent = z.infer<typeof collectiveWorkProgressIntentSchema>;
export type CollectiveWorkProgressReceipt = z.infer<typeof collectiveWorkProgressReceiptSchema>;
