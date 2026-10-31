export interface PawFeelDutyConfig {
  systemThreadId: 'thread_eval_friction';
  primaryCatId?: string;
  backupCatId?: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

export function isCompletePawFeelDutyConfig(
  config: PawFeelDutyConfig | null | undefined,
): config is PawFeelDutyConfig & { primaryCatId: string; backupCatId: string } {
  return Boolean(config?.primaryCatId && config.backupCatId && config.primaryCatId !== config.backupCatId);
}

export interface PawFeelReconciliationCoverage {
  coverageStartAt: string;
  /** Cutover boundary after which only typed capture may mint new rows. */
  typedCaptureActivatedAt?: string;
  lastFullScanStartedAt?: string;
  lastFullScanCompletedAt?: string;
  lastOverlapCompletedAt?: string;
  lastSeenTimelineAt?: string;
  status: 'uninitialized' | 'healthy' | 'lagging' | 'unavailable';
  lagMs?: number;
  unavailableReason?: string;
}
