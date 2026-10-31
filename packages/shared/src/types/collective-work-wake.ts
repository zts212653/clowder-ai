import { z } from 'zod';
import { collectiveWorkIdSchema } from './collective-collaboration-identifiers.js';

const eventId = z.string().regex(/^evt_[A-Za-z0-9_-]{8,}$/);

export const collectiveWorkWakeNoticeSchema = z
  .object({
    v: z.literal(1),
    reason: z.enum(['dependency_completed', 'comment']),
    workId: collectiveWorkIdSchema,
    workRevision: z.number().int().positive(),
    assignmentEventId: eventId,
    executionRevision: z.number().int().positive(),
    dependencyWorkId: collectiveWorkIdSchema.optional(),
    dependencyWorkRevision: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((notice, context) => {
    const hasDependency = Boolean(notice.dependencyWorkId && notice.dependencyWorkRevision);
    if ((notice.reason === 'dependency_completed') !== hasDependency) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Dependency completion wakes require exact dependency identity and revision',
      });
    }
  });

export type CollectiveWorkWakeNotice = z.infer<typeof collectiveWorkWakeNoticeSchema>;
