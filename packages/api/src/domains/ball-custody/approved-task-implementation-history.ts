import { ACTION_SUCCESSOR_ACTION_FAMILIES } from '@cat-cafe/shared';
import { z } from 'zod';
import { ActionSuccessorKeys } from './action-successor-keys.js';
import { ApprovedTaskContinuationUnavailable } from './approved-task-continuation-diagnostics.js';

// ActionSuccessorRecoveryIndex retains the exact original bytes when its full lease decoder fails.
const recoveryEnvelopeSchema = z
  .object({
    _invalidRaw: z.string().nullable(),
    disposition: z.literal('needs_attention'),
    reasonCode: z.enum(['malformed_lease', 'lease_missing']),
  })
  .strict();

const historyIdentitySchema = z.object({
  leaseId: z.string().min(1),
  key: z.string().min(1),
  generation: z.number(),
  tenantScope: z.string().min(1),
  subjectRef: z.string().min(1),
  actionFamily: z.enum(ACTION_SUCCESSOR_ACTION_FAMILIES),
});

/** Only the facts needed to decide whether an approval has already been used. */
const implementationHistorySchema = historyIdentitySchema.extend({
  holderThreadId: z.string().nullish(),
  evidenceRefs: z.array(z.string()),
  returnTransitions: z
    .array(z.object({ rejectingThreadId: z.string().optional() }))
    .nullish()
    .transform((value) => value ?? []),
  replacementTransitions: z
    .array(z.object({ fromHolderThreadId: z.string().min(1), toHolderThreadId: z.string().min(1) }))
    .nullish()
    .transform((value) => value ?? []),
});

export type ApprovedTaskImplementationHistory = z.output<typeof implementationHistorySchema>;

/**
 * Historical use is not completion verification. A legacy completion candidate
 * must not make every unrelated approval unavailable. Keep identity/provenance
 * validation and leave the full lease/completion decoder unchanged.
 */
export function parseApprovedTaskImplementationHistory(
  raw: string | null,
  target: { tenantScope: string; subjectRef: string },
  detailKey: string,
): ApprovedTaskImplementationHistory | null {
  const unavailable = (stage: 'missing' | 'json' | 'identity' | 'provenance' | 'recovery_envelope'): never => {
    throw new ApprovedTaskContinuationUnavailable(stage, 'implementation_history', detailKey);
  };
  const decode = (value: string | null): unknown => {
    if (!value) return unavailable('missing');
    try {
      return JSON.parse(value);
    } catch {
      return unavailable('json');
    }
  };
  let persisted = decode(raw);
  const wrapped = persisted !== null && typeof persisted === 'object' && Object.hasOwn(persisted, '_invalidRaw');
  if (wrapped) {
    const envelope = recoveryEnvelopeSchema.safeParse(persisted);
    if (!envelope.success) return unavailable('recovery_envelope');
    persisted = decode(envelope.data._invalidRaw);
  }
  const decodedIdentity = historyIdentitySchema.safeParse(persisted);
  if (!decodedIdentity.success) return unavailable('identity');
  const identity = decodedIdentity.data;
  // Retained bytes must belong to this same canonical row, never another record's identity.
  if (wrapped && detailKey !== ActionSuccessorKeys.detail(identity.leaseId)) return unavailable('identity');
  if (
    identity.actionFamily !== 'implement' ||
    identity.tenantScope !== target.tenantScope ||
    identity.subjectRef !== target.subjectRef
  )
    return null;
  const history = implementationHistorySchema.safeParse(persisted);
  if (!history.success) return unavailable('provenance');
  return history.data;
}
