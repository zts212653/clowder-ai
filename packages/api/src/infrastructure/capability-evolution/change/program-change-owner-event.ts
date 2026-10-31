import {
  type EvolutionProgramEventEnvelopeV1,
  type EvolutionProgramEventV1,
  exactAssetVersionRefV1Schema,
  ownerTruthRefV1Schema,
  refIdentity,
} from '@cat-cafe/shared';
import { EvolutionProgramServiceError } from '../program-command-contract.js';
import type { EvolutionChangeOwnerSnapshot, EvolutionChangeRefs } from './program-change-owner-contract.js';
import {
  type EvolutionChangeLineageV1,
  type ExactAssetVersionRefV1,
  projectEvolutionProgramLineage,
} from './program-lineage.js';

function fail(message: string): never {
  throw new EvolutionProgramServiceError('invalid_command', message);
}

function exactTarget(value: unknown): ExactAssetVersionRefV1 {
  return exactAssetVersionRefV1Schema.parse(value) as ExactAssetVersionRefV1;
}

function sameAsset(left: ExactAssetVersionRefV1, right: ExactAssetVersionRefV1): boolean {
  return (
    left.ownerFeatureId === right.ownerFeatureId && left.assetKind === right.assetKind && left.assetId === right.assetId
  );
}

function requiredRef(value: unknown, label: string) {
  if (value === undefined) return fail(`owner ${label} is missing`);
  return ownerTruthRefV1Schema.parse(value);
}

function time(value: string | undefined, label: string): number {
  const parsed = Date.parse(value ?? '');
  if (!Number.isFinite(parsed)) return fail(`owner ${label} timestamp is invalid`);
  return parsed;
}

function approvalEvent(snapshot: EvolutionChangeOwnerSnapshot, active: EvolutionChangeRefs): EvolutionProgramEventV1 {
  return {
    type: 'approval_linked',
    approvalRef: requiredRef(snapshot.approvalRef, 'approval ref'),
    targetVersionRef: active.targetVersionRef,
  };
}

function changedInterventionEvent(
  snapshot: EvolutionChangeOwnerSnapshot,
  active: EvolutionChangeRefs,
): EvolutionProgramEventV1 {
  const assetVersionRef = exactTarget(snapshot.assetVersionRef);
  if (!sameAsset(assetVersionRef, active.targetVersionRef))
    return fail('intervention receipt belongs to another asset');
  const changedAt = time(snapshot.changedAt, 'changedAt');
  const loadedAt = time(snapshot.loadedAt, 'loadedAt');
  if (changedAt > loadedAt) return fail('changed intervention must be loaded after the owner mutation');
  return {
    type: 'intervention_receipt_linked',
    result: 'changed',
    interventionReceiptRef: requiredRef(snapshot.interventionReceiptRef, 'intervention receipt'),
    assetVersionRef,
    loadedRuntimeRef: requiredRef(snapshot.loadedRuntimeRef, 'loaded runtime ref'),
  };
}

function noChangeInterventionEvent(
  snapshot: EvolutionChangeOwnerSnapshot,
  active: EvolutionChangeRefs,
): EvolutionProgramEventV1 {
  if (
    snapshot.assetVersionRef !== undefined &&
    refIdentity(snapshot.assetVersionRef) !== refIdentity(active.targetVersionRef)
  ) {
    return fail('no-change intervention must preserve the exact target version');
  }
  if (snapshot.loadedRuntimeRef !== undefined) return fail('no-change intervention must not invent a loaded runtime');
  time(snapshot.recordedAt, 'no-change recordedAt');
  return {
    type: 'intervention_receipt_linked',
    result: 'no_change',
    interventionReceiptRef: requiredRef(snapshot.interventionReceiptRef, 'no-change intervention receipt'),
    assetVersionRef: active.targetVersionRef,
  };
}

function interventionEvent(
  snapshot: EvolutionChangeOwnerSnapshot,
  active: EvolutionChangeRefs,
): EvolutionProgramEventV1 {
  const noChange = snapshot.status === 'no_change' || snapshot.recordedAt !== undefined;
  return noChange ? noChangeInterventionEvent(snapshot, active) : changedInterventionEvent(snapshot, active);
}

function validateChangedOutcome(
  snapshot: EvolutionChangeOwnerSnapshot,
  linked: EvolutionChangeLineageV1,
  measuredAt: number,
): void {
  const assetVersionRef = exactTarget(snapshot.assetVersionRef);
  if (!linked.assetVersionRef) fail('linked changed intervention has no exact asset version');
  if (refIdentity(assetVersionRef) !== refIdentity(linked.assetVersionRef)) {
    fail('fresh outcome must bind the exact linked intervention version');
  }
  if (
    !linked.loadedRuntimeRef ||
    refIdentity(requiredRef(snapshot.loadedRuntimeRef, 'loaded runtime ref')) !== refIdentity(linked.loadedRuntimeRef)
  ) {
    fail('fresh outcome must bind the linked loaded runtime');
  }
  const changedAt = time(snapshot.changedAt, 'changedAt');
  const loadedAt = time(snapshot.loadedAt, 'loadedAt');
  if (!(changedAt <= loadedAt && loadedAt < measuredAt)) {
    fail('outcome requires a loaded runtime and fresh post-load measurement');
  }
}

function validateNoChangeOutcome(
  snapshot: EvolutionChangeOwnerSnapshot,
  linked: EvolutionChangeLineageV1,
  measuredAt: number,
): void {
  if (snapshot.loadedRuntimeRef !== undefined) fail('no-change outcome must not invent a loaded runtime');
  if (linked.assetVersionRef === undefined) fail('linked no-change intervention has no exact asset version');
  if (
    snapshot.assetVersionRef !== undefined &&
    refIdentity(snapshot.assetVersionRef) !== refIdentity(linked.assetVersionRef)
  ) {
    fail('no-change outcome must preserve the exact asset version');
  }
  if (time(snapshot.recordedAt, 'no-change recordedAt') >= measuredAt) {
    fail('no-change outcome requires a fresh post-receipt measurement');
  }
}

function outcomeEvent(
  snapshot: EvolutionChangeOwnerSnapshot,
  events: readonly EvolutionProgramEventEnvelopeV1[],
): EvolutionProgramEventV1 {
  const linked = projectEvolutionProgramLineage(events).current;
  if (!linked?.interventionReceiptRef || !linked.assetVersionRef || !linked.interventionKind) {
    return fail('fresh outcome requires the linked owner intervention receipt');
  }
  if (
    refIdentity(linked.interventionReceiptRef) !== refIdentity(requiredRef(snapshot.interventionReceiptRef, 'receipt'))
  ) {
    return fail('fresh outcome requires the linked owner intervention receipt');
  }
  const measuredAt = time(snapshot.measuredAt, 'measuredAt');
  if (linked.interventionKind === 'changed') {
    validateChangedOutcome(snapshot, linked, measuredAt);
  } else {
    validateNoChangeOutcome(snapshot, linked, measuredAt);
  }
  return {
    type: 'outcome_linked',
    outcomeReceiptRef: requiredRef(snapshot.outcomeReceiptRef, 'outcome receipt'),
    freshnessProofRef: requiredRef(snapshot.freshnessProofRef, 'freshness proof'),
  };
}

export function eventForOwnerSnapshot(
  snapshot: EvolutionChangeOwnerSnapshot,
  active: EvolutionChangeRefs,
  events: readonly EvolutionProgramEventEnvelopeV1[],
): EvolutionProgramEventV1 {
  const linked = projectEvolutionProgramLineage(events).current;
  if (!linked) return fail('the Program has no active F266/F313 change cycle');
  switch (snapshot.status) {
    case 'pending':
      return fail('pending owner snapshot has no new Program edge');
    case 'approved':
      return approvalEvent(snapshot, active);
    case 'rejected':
    case 'withdrawn':
    case 'superseded':
    case 'target_drift':
      return {
        type: 'approval_rejected_or_superseded',
        result: snapshot.status,
        decisionRef: requiredRef(snapshot.decisionRef, 'approval decision ref'),
      };
    case 'mutated':
      return linked.status === 'pending' ? approvalEvent(snapshot, active) : changedInterventionEvent(snapshot, active);
    case 'no_change':
      return linked.status === 'pending'
        ? approvalEvent(snapshot, active)
        : noChangeInterventionEvent(snapshot, active);
    case 'outcome':
      if (linked.status === 'pending') return approvalEvent(snapshot, active);
      if (linked.status === 'approved') return interventionEvent(snapshot, active);
      return outcomeEvent(snapshot, events);
  }
}
