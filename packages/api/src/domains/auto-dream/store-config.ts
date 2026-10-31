export const DEFAULT_AWAKENED_LEASE_MS = 90 * 60_000;
export const DEFAULT_FOREGROUND_VISIT_BUDGET = 3;

export interface AutoDreamStoreOptions {
  now?: () => number;
  idFactory?: (prefix: string) => string;
  awakenedLeaseMs?: number;
  foregroundVisitBudget?: number;
}

export function resolveAwakenedLeaseMs(value = DEFAULT_AWAKENED_LEASE_MS): number {
  const leaseMs = Math.trunc(value);
  if (!Number.isFinite(value) || leaseMs <= 0) {
    throw new Error('awakenedLeaseMs must be a positive finite number');
  }
  return leaseMs;
}

export function resolveForegroundVisitBudget(value = DEFAULT_FOREGROUND_VISIT_BUDGET): number {
  const budget = Math.trunc(value);
  if (!Number.isFinite(value) || budget <= 0 || budget > 100) {
    throw new Error('foregroundVisitBudget must be an integer between 1 and 100');
  }
  return budget;
}

export interface SettlementIds {
  runId: string;
  diaryId?: string;
  postureId?: string;
  seedId?: string;
  intentId?: string;
  visitId?: string;
  visibilityBlock?: 'quiet_hours' | 'budget_exhausted';
}
