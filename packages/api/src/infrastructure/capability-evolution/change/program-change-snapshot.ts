import { type OwnerTruthRefV1, refIdentity } from '@cat-cafe/shared';
import { EvolutionProgramServiceError } from '../program-command-contract.js';
import type { EvolutionChangeOwnerSnapshot, EvolutionChangeRefs } from './program-change-owner-contract.js';
import type { EvolutionChangeLineageV1 } from './program-lineage.js';

const sameRef = (left: EvolutionChangeRefs['caseRef'], right: EvolutionChangeRefs['caseRef']): boolean =>
  refIdentity(left) === refIdentity(right);

function sameOptional(left: OwnerTruthRefV1 | undefined, right: OwnerTruthRefV1 | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && sameRef(left, right);
}

function fail(message: string): never {
  throw new EvolutionProgramServiceError('invalid_command', message);
}

export function assertSnapshotIdentity(snapshot: EvolutionChangeOwnerSnapshot, active: EvolutionChangeLineageV1): void {
  if (snapshot.ownerAuthorizationRef === undefined) {
    fail('canonical change owner published no owner authorization for the exact mutation surface');
  }
  if (!sameRef(snapshot.caseRef, active.caseRef) || !sameRef(snapshot.proposalRef, active.proposalRef)) {
    fail('owner snapshot does not match the active change cycle');
  }
  if (snapshot.status !== 'target_drift' && !sameRef(snapshot.targetVersionRef, active.targetVersionRef)) {
    fail('fresh Approval must bind the active exact target/version');
  }
  if (snapshot.status !== 'target_drift' && !sameRef(snapshot.ownerAuthorizationRef, active.ownerAuthorizationRef)) {
    fail('owner authorization does not match the active exact mutation surface');
  }
  if (active.approvalRef !== undefined) {
    if (snapshot.approvalRef !== undefined && !sameRef(snapshot.approvalRef, active.approvalRef)) {
      fail('canonical Approval ref changed after it was linked');
    }
    const carriesApproval =
      snapshot.status === 'approved' ||
      snapshot.status === 'mutated' ||
      snapshot.status === 'no_change' ||
      snapshot.status === 'outcome';
    if (carriesApproval && snapshot.approvalRef === undefined) {
      fail('canonical Approval ref changed after it was linked');
    }
  }
}

function linkedProgressMatches(snapshot: EvolutionChangeOwnerSnapshot, active: EvolutionChangeLineageV1): boolean {
  switch (snapshot.status) {
    case 'pending':
      return active.status === 'pending';
    case 'approved':
      return active.status === 'approved' && sameOptional(snapshot.approvalRef, active.approvalRef);
    case 'rejected':
    case 'withdrawn':
    case 'superseded':
    case 'target_drift':
      return active.status === snapshot.status && sameOptional(snapshot.decisionRef, active.approvalDecisionRef);
    case 'mutated':
      return (
        active.status === 'changed' &&
        active.interventionKind === 'changed' &&
        sameOptional(snapshot.approvalRef, active.approvalRef) &&
        sameOptional(snapshot.interventionReceiptRef, active.interventionReceiptRef) &&
        sameOptional(snapshot.assetVersionRef, active.assetVersionRef) &&
        sameOptional(snapshot.loadedRuntimeRef, active.loadedRuntimeRef)
      );
    case 'no_change':
      return (
        active.status === 'no_change' &&
        active.interventionKind === 'no_change' &&
        sameOptional(snapshot.approvalRef, active.approvalRef) &&
        sameOptional(snapshot.interventionReceiptRef, active.interventionReceiptRef) &&
        (snapshot.assetVersionRef === undefined ||
          (active.assetVersionRef !== undefined && sameRef(snapshot.assetVersionRef, active.assetVersionRef))) &&
        active.loadedRuntimeRef === undefined
      );
    case 'outcome':
      return (
        active.status === 'outcome' &&
        sameOptional(snapshot.approvalRef, active.approvalRef) &&
        sameOptional(snapshot.interventionReceiptRef, active.interventionReceiptRef) &&
        (active.interventionKind === 'changed'
          ? sameOptional(snapshot.assetVersionRef, active.assetVersionRef)
          : snapshot.assetVersionRef === undefined ||
            (active.assetVersionRef !== undefined && sameRef(snapshot.assetVersionRef, active.assetVersionRef))) &&
        sameOptional(snapshot.loadedRuntimeRef, active.loadedRuntimeRef) &&
        sameOptional(snapshot.outcomeReceiptRef, active.outcomeReceiptRef) &&
        sameOptional(snapshot.freshnessProofRef, active.freshnessProofRef)
      );
  }
}

export function ownerProgressAlreadyLinked(
  snapshot: EvolutionChangeOwnerSnapshot,
  active: EvolutionChangeLineageV1,
): boolean {
  const sameStatus =
    snapshot.status === active.status ||
    (snapshot.status === 'mutated' && active.status === 'changed') ||
    (snapshot.status === 'no_change' && active.status === 'no_change') ||
    (snapshot.status === 'approved' && active.status === 'approved');
  if (!sameStatus) return false;
  if (!linkedProgressMatches(snapshot, active)) {
    fail('canonical owner changed refs for an already-linked change status');
  }
  return true;
}

const CLOSED_STATUSES = new Set<EvolutionChangeLineageV1['status']>([
  'rejected',
  'withdrawn',
  'superseded',
  'target_drift',
]);

/** Owner snapshots may skip ahead, but never move backwards or revive a closed proposal. */
export function assertOwnerProgressCanAdvance(
  snapshot: EvolutionChangeOwnerSnapshot,
  active: EvolutionChangeLineageV1,
): void {
  if (CLOSED_STATUSES.has(active.status)) fail('canonical owner snapshot revived a closed change attempt');
  if (active.status === 'outcome') fail('canonical owner snapshot regressed from a completed outcome');
  if ((active.status === 'changed' || active.status === 'no_change') && snapshot.status !== 'outcome') {
    fail('canonical owner snapshot regressed after intervention receipt');
  }
  if (active.status === 'approved' && snapshot.status === 'pending') {
    fail('canonical owner snapshot regressed to pending');
  }
}
