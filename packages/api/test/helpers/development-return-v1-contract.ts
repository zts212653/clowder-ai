// Frozen reader contract from 6d350153fb (parent of PR4657), before reviewed lineage.
// This fixture intentionally does not derive its shape from the current schema.

import { developmentTaskRefSchema } from '@cat-cafe/shared';
import { z } from 'zod';

const ref = z.string().min(1).max(300);
const revision = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const legacyDevelopmentReturnV1Schema = z
  .object({
    v: z.literal(1),
    registrationId: ref,
    ownerUserId: ref,
    ownerThreadId: ref,
    ownerCatId: ref,
    taskRef: developmentTaskRefSchema,
    observedRevision: z.number().int().positive(),
    deliveryRevision: z.number().int().positive().optional(),
    proposalId: ref,
    executionThreadId: ref,
    reporterCatIds: z.array(ref).min(1).max(16),
    sourceActionRef: ref,
    sourceMessageRevision: revision,
    predecessorRegistrationId: ref.optional(),
    expectedSignal: z.literal('terminal_report'),
    slaUntil: z.number().int().positive(),
    registeredAt: z.number().int().nonnegative(),
    status: z.enum(['waiting', 'ready', 'delivering', 'delivered', 'retired']),
    report: z
      .object({
        sourceMessageId: ref,
        outcome: z.enum(['completed', 'failed', 'blocked']),
        evidenceRefs: z.array(ref).min(1).max(32),
        sourceMessageRevision: revision,
      })
      .strict()
      .optional(),
    reason: z.enum(['terminal_report', 'deadline_review', 'cancelled', 'owner_changed', 'delivery_failed']).optional(),
    wakeMessageId: ref.optional(),
  })
  .strict();
