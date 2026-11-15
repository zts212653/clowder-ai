export type RecoveryDisposition = 'parked' | 'interrupted' | 'needs_attention';

export interface RecoveryDetail {
  owner: 'wait' | 'job';
  disposition: RecoveryDisposition;
  reasonCode: string;
  recheck: boolean;
}

export const recoveryObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export function readRecovery(value: unknown, owner: RecoveryDetail['owner']): RecoveryDetail | null {
  const fact = recoveryObject(value);
  const recheck = recoveryObject(fact?.recheck);
  if (
    !fact ||
    !['parked', 'interrupted', 'needs_attention'].includes(String(fact.disposition)) ||
    typeof fact.reasonCode !== 'string'
  )
    return null;
  return {
    owner,
    disposition: fact.disposition as RecoveryDisposition,
    reasonCode: fact.reasonCode,
    recheck: recheck?.kind === 'observe_original_wait' || recheck?.kind === 'observe_original_job',
  };
}

export function recoveryPending(value: unknown): boolean {
  const fact = recoveryObject(value);
  if (!fact || fact.disposition) return false;
  const wakeIntent = recoveryObject(fact.wakeIntent);
  return (
    typeof fact.nextAttemptAt === 'number' || recoveryObject(fact.claim) !== null || wakeIntent?.status === 'pending'
  );
}
