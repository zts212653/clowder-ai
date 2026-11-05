import { z } from 'zod';

export const workReferenceSchema = z
  .object({
    contentRef: z.string().min(1).max(2048),
    ownerRevision: z.number().int().positive().safe(),
  })
  .strict();
export type WorkReference = z.infer<typeof workReferenceSchema>;
