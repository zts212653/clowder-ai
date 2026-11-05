export interface ManagedCommandWaitRecoveryFact {
  readonly v: 1;
  readonly attempts: number;
  readonly waitGeneration?: number;
  readonly nextAttemptAt: number | null;
  readonly disposition?: 'parked' | 'interrupted' | 'needs_attention';
  readonly reasonCode?: string;
  readonly recheck?: { readonly kind: 'observe_original_wait'; readonly taskId: string };
  readonly claim?: { readonly expiresAt: number };
  readonly consumption?: {
    readonly ownerTaskId: string;
    readonly userId: string;
    readonly threadId: string;
    readonly sourceMessageId: string;
    readonly catId: string;
    readonly generation: number;
  };
  readonly notification?: {
    readonly key: string;
    readonly reasonCode: string;
    readonly attempts: number;
    readonly deliveredAt?: number;
    readonly target?: { readonly userId: string; readonly threadId: string; readonly catId: string };
  };
}

export interface ManagedCommandWaitRecoverySnapshot {
  readonly revision: number;
  readonly fact: ManagedCommandWaitRecoveryFact;
}

export type ManagedCommandWaitRecoveryOutcome =
  | { kind: 'waiting'; parkReason?: string; notifyOwner?: false }
  | { kind: 'retryable_error'; reason: string }
  | { kind: 'permanent_error'; reason: string }
  | { kind: 'stale' }
  | { kind: 'settled' };

export function planManagedCommandWaitRecovery(
  current: ManagedCommandWaitRecoveryFact,
  outcome: ManagedCommandWaitRecoveryOutcome,
  taskId: string,
  now: number,
): ManagedCommandWaitRecoveryFact {
  const { claim: _claim, ...fact } = current;
  if (outcome.kind === 'stale') return { ...fact, nextAttemptAt: now + 30_000 };
  if (outcome.kind === 'settled')
    return {
      ...fact,
      disposition: undefined,
      reasonCode: undefined,
      nextAttemptAt: fact.notification && !fact.notification.deliveredAt && fact.notification.attempts < 5 ? now : null,
    };
  if (outcome.kind === 'waiting' && !outcome.parkReason) return { ...fact, nextAttemptAt: now + 30_000 };
  if (outcome.kind === 'waiting')
    return {
      ...fact,
      disposition: 'parked',
      reasonCode: outcome.parkReason,
      recheck: { kind: 'observe_original_wait', taskId },
      nextAttemptAt: outcome.notifyOwner === false ? null : now,
      notification:
        outcome.notifyOwner === false
          ? fact.notification
          : (fact.notification ?? {
              key: `managed-wait:${taskId}:g${fact.waitGeneration ?? fact.consumption?.generation ?? 0}:${outcome.parkReason}`,
              reasonCode: outcome.parkReason ?? 'carrier_unresolved',
              attempts: 0,
            }),
    };
  const attempts = current.attempts + (outcome.kind === 'retryable_error' ? 1 : 0);
  if (outcome.kind === 'permanent_error' || attempts >= 5)
    return {
      ...fact,
      attempts,
      nextAttemptAt: now,
      disposition: outcome.kind === 'permanent_error' ? 'needs_attention' : 'parked',
      reasonCode: outcome.reason,
      recheck: { kind: 'observe_original_wait', taskId },
      notification: fact.notification ?? {
        key: `managed-wait:${taskId}:g${fact.waitGeneration ?? fact.consumption?.generation ?? 0}:${outcome.reason}`,
        reasonCode: outcome.reason,
        attempts: 0,
      },
    };
  return { ...fact, attempts, nextAttemptAt: now + Math.min(300_000, 1000 * 2 ** attempts) };
}
