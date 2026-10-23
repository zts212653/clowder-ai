import { ACTION_SUCCESSOR_ACTION_FAMILIES } from '@cat-cafe/shared';
import { z } from 'zod';

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
): ApprovedTaskImplementationHistory | null {
  if (!raw) throw new Error('indexed implementation history is missing');
  const persisted: unknown = JSON.parse(raw);
  const identity = historyIdentitySchema.parse(persisted);
  if (
    identity.actionFamily !== 'implement' ||
    identity.tenantScope !== target.tenantScope ||
    identity.subjectRef !== target.subjectRef
  )
    return null;
  return implementationHistorySchema.parse(persisted);
}
