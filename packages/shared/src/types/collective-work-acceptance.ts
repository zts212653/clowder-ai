import { z } from 'zod';

const ref = z.string().trim().min(1).max(240);
/** Service-issued acceptance relation; normal Human/Agent message commands cannot supply it. */
export const collectiveWorkAcceptanceNoticeSchema = z
  .object({
    v: z.literal(1),
    workId: ref.regex(/^work_[A-Za-z0-9_-]{8,}$/),
    sourceEventId: ref.regex(/^evt_[A-Za-z0-9_-]{8,}$/),
    operationRef: ref,
    grantRef: ref,
    grantRevision: z.number().int().positive(),
    requestKind: ref,
  })
  .strict();

export const collectiveWorkHostAdmissionSchema = z
  .object({
    issuer: z.literal('host'),
    state: z.enum(['admitted', 'rejected']),
    receiptRef: ref,
    at: z.string().datetime(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const collectiveWorkAcceptanceSchema = collectiveWorkAcceptanceNoticeSchema
  .extend({
    hostAdmission: collectiveWorkHostAdmissionSchema.optional(),
    hostAdmissionHistory: z.array(collectiveWorkHostAdmissionSchema).optional(),
  })
  .strict();
export type CollectiveWorkAcceptanceNotice = z.infer<typeof collectiveWorkAcceptanceNoticeSchema>;
export type CollectiveWorkHostAdmission = z.infer<typeof collectiveWorkHostAdmissionSchema>;

/** Live Service projection, never a Host receipt or a persisted permission ledger. */
export const collectiveWorkExecutionStatusSchema = z
  .object({
    issuer: z.literal('service'),
    revision: z.number().int().positive(),
    state: z.enum(['permitted', 'awaiting_admission', 'unavailable']),
    reason: z
      .enum([
        'WORK_DELEGATION_UNAVAILABLE',
        'PARTICIPATION_REVOKED',
        'WORK_ADMISSION_NOT_CURRENT',
        'CONNECTION_REVOKED',
        'WORK_SOURCE_UNAVAILABLE',
        'MEMBERSHIP_REVOKED',
      ])
      .optional(),
  })
  .strict();

/** Current execution permission is versioned independently of immutable first acceptance and assignment. */
export const collectiveWorkExecutionNoticeSchema = collectiveWorkAcceptanceNoticeSchema
  .extend({
    revision: z.number().int().positive(),
    assignmentEventId: ref.regex(/^evt_[A-Za-z0-9_-]{8,}$/),
    participationRevision: z.number().int().positive(),
    resultRevision: z.number().int().positive(),
  })
  .strict();
export const collectiveWorkExecutionAuthoritySchema = collectiveWorkExecutionNoticeSchema
  .extend({
    eventId: ref.regex(/^evt_[A-Za-z0-9_-]{8,}$/),
    hostAdmission: collectiveWorkHostAdmissionSchema.optional(),
    hostAdmissionHistory: z.array(collectiveWorkHostAdmissionSchema).optional(),
  })
  .strict();
export type CollectiveWorkExecutionNotice = z.infer<typeof collectiveWorkExecutionNoticeSchema>;
export type CollectiveWorkExecutionAuthority = z.infer<typeof collectiveWorkExecutionAuthoritySchema>;
