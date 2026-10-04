import { z } from 'zod';
import { developmentTaskRefSchema } from './growing-development.js';

export const DEVELOPMENT_RETURN_TEMPLATE_ID = 'development-terminal-return';
const ref = z.string().min(1).max(300);
const sourceRevision = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const report = z
  .object({
    sourceMessageId: ref,
    outcome: z.enum(['completed', 'failed', 'blocked']),
    evidenceRefs: z.array(ref).min(1).max(32),
  })
  .strict();

/** Scheduler-owned continuation relation; not a Task status or producer judgment. */
export const developmentReturnRegistrationV1Schema = z
  .object({
    v: z.literal(1),
    registrationId: ref,
    ownerUserId: ref,
    ownerThreadId: ref,
    ownerCatId: ref,
    taskRef: developmentTaskRefSchema,
    observedRevision: z.number().int().positive(),
    // Snapshot at delivery claim; immutable so Dispatch retries reuse the exact same carrier.
    deliveryRevision: z.number().int().positive().optional(),
    proposalId: ref,
    executionThreadId: ref,
    reporterCatIds: z.array(ref).min(1).max(16),
    sourceActionRef: ref,
    sourceMessageRevision: sourceRevision,
    predecessorRegistrationId: ref.optional(),
    expectedSignal: z.literal('terminal_report'),
    slaUntil: z.number().int().positive(),
    registeredAt: z.number().int().nonnegative(),
    status: z.enum(['waiting', 'ready', 'delivering', 'delivered', 'retired']),
    report: report.extend({ sourceMessageRevision: sourceRevision }).optional(),
    reason: z.enum(['terminal_report', 'deadline_review', 'cancelled', 'owner_changed', 'delivery_failed']).optional(),
    wakeMessageId: ref.optional(),
  })
  .strict();
export type DevelopmentReturnRegistrationV1 = z.infer<typeof developmentReturnRegistrationV1Schema>;

export const developmentReturnActionV1Schema = z
  .object({
    action: z.enum(['register', 'read', 'report']),
    registrationId: ref.optional(),
    taskId: ref.optional(),
    expectedRevision: z.number().int().positive().optional(),
    executionThreadId: ref.optional(),
    predecessorRegistrationId: ref.optional(),
    sourceActionRef: ref.optional(),
    expectedSignal: z.literal('terminal_report').optional(),
    slaUntil: z.number().int().positive().optional(),
    report: report.optional(),
  })
  .strict();
export type DevelopmentReturnActionV1 = z.infer<typeof developmentReturnActionV1Schema>;
