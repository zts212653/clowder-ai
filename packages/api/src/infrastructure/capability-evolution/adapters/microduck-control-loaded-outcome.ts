import type { ExactAssetVersionRefV1, OwnerTruthRefV1 } from '@cat-cafe/shared';
import type { MicroduckControlSlotVersionV1 } from './microduck-control-slot-owner.js';
import type {
  MicroduckBlocked,
  MicroduckFreshOutcome,
  MicroduckRestoreOutcome,
  MicroduckRollbackReceipt,
} from './microduck-owner-contract.js';
import { blocked, isMicroduckHashRef, ownerRef } from './microduck-owner-validation.js';

export type MicroduckRestoreAttemptDiagnosis =
  | {
      readonly kind: 'measured_mismatch';
      readonly slotState: 'rolled_back';
      readonly nextAction: 'investigate_reference_environment_or_determinism';
    }
  | {
      readonly kind: 'execution_refusal';
      readonly slotState: 'rolled_back';
      readonly nextAction: 'retry_physical_restore_verification';
    };

export type MicroduckControlLoadedOutcomeInput =
  | {
      readonly mode: 'post_writeback';
      readonly operationReceiptRef: OwnerTruthRefV1;
      readonly targetVersionRef: ExactAssetVersionRefV1;
      readonly version: MicroduckControlSlotVersionV1;
    }
  | {
      readonly mode: 'post_rollback';
      readonly operationReceiptRef: OwnerTruthRefV1;
      readonly deploymentReceiptRef: OwnerTruthRefV1;
      readonly targetVersionRef: ExactAssetVersionRefV1;
      readonly referenceFreshOutcomeRef: OwnerTruthRefV1;
      readonly version: MicroduckControlSlotVersionV1;
    };

/** The implementation resolves owner-private receipt refs; callers never supply filesystem paths. */
export interface MicroduckControlLoadedOutcomeRunner {
  collect(
    input: MicroduckControlLoadedOutcomeInput,
  ): Promise<MicroduckFreshOutcome | MicroduckRestoreOutcome | MicroduckBlocked>;
}

export function diagnoseMicroduckRestoreAttempt(value: MicroduckBlocked): MicroduckRestoreAttemptDiagnosis | undefined {
  if (
    value.code !== 'rollback_failed' ||
    !value.blockerRef ||
    !value.recoveryRef ||
    !isMicroduckHashRef(value.recoveryRef, 'rollback-receipt')
  ) {
    return undefined;
  }
  if (isMicroduckHashRef(value.blockerRef, 'restore-outcome-attempt')) {
    return {
      kind: 'measured_mismatch',
      slotState: 'rolled_back',
      nextAction: 'investigate_reference_environment_or_determinism',
    };
  }
  if (isMicroduckHashRef(value.blockerRef, 'restore-execution-attempt')) {
    return {
      kind: 'execution_refusal',
      slotState: 'rolled_back',
      nextAction: 'retry_physical_restore_verification',
    };
  }
  return undefined;
}

export async function collectMicroduckLoadedOutcome(
  runner: MicroduckControlLoadedOutcomeRunner,
  input: MicroduckControlLoadedOutcomeInput,
  fallback: 'fresh_outcome_missing' | 'rollback_failed',
): Promise<MicroduckFreshOutcome | MicroduckRestoreOutcome | MicroduckBlocked> {
  try {
    return await runner.collect(input);
  } catch {
    return blocked(fallback);
  }
}

export function microduckRestoreBlocked(
  issue: MicroduckBlocked,
  rollbackReceipt: MicroduckRollbackReceipt,
): MicroduckBlocked {
  const blockerRef =
    issue.blockerRef &&
    (isMicroduckHashRef(issue.blockerRef, 'restore-outcome-attempt') ||
      isMicroduckHashRef(issue.blockerRef, 'restore-execution-attempt'))
      ? ownerRef(issue.blockerRef)
      : undefined;
  return blocked('rollback_failed', {
    ...(blockerRef ? { blockerRef } : {}),
    recoveryRef: ownerRef(rollbackReceipt.rollbackReceiptRef),
  });
}
