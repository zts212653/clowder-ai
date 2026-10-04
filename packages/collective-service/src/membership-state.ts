import { z } from 'zod';

const membershipHistoryEntrySchema = z
  .object({
    revision: z.number().int().positive(),
    action: z.enum(['joined', 'left']),
    at: z.string().datetime(),
    role: z.enum(['steward', 'member']),
    reason: z.literal('self_left').optional(),
  })
  .strict();

export const membershipSchema = z
  .object({
    collectiveId: z.string(),
    humanId: z.string(),
    role: z.enum(['steward', 'member']),
    joinedAt: z.string().datetime(),
    status: z.enum(['active', 'left']).default('active'),
    revision: z.number().int().positive().default(1),
    leftAt: z.string().datetime().optional(),
    leaveReason: z.literal('self_left').optional(),
    history: z.array(membershipHistoryEntrySchema).default([]),
  })
  .strict()
  .superRefine((membership, context) => {
    if (membership.status === 'left' && (!membership.leftAt || !membership.leaveReason)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['leftAt'],
        message: 'Ended membership requires a timestamp and reason',
      });
    }
    if (membership.status === 'active' && (membership.leftAt || membership.leaveReason)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'Active membership cannot retain ended-state fields',
      });
    }
  });
