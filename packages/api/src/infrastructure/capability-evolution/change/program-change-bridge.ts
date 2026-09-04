import { createHash } from 'node:crypto';
import {
  type EvolutionCycleDecision,
  type EvolutionProgramEventEnvelopeV1,
  type EvolutionProgramEventV1,
  exactAssetVersionRefV1Schema,
  ownerTruthRefV1Schema,
  refIdentity,
} from '@cat-cafe/shared';
import type { EvolutionProgramServiceResult } from '../program-command-contract.js';
import { EvolutionProgramServiceError } from '../program-command-contract.js';
import type { EvolutionProgramProjectionV1 } from '../program-projection.js';
import type { CommandBase } from '../program-service-options.js';
import type {
  EvolutionChangeRefs as ChangeRefs,
  EvolutionChangeOwnerBlocked,
  EvolutionChangeOwnerPort,
  EvolutionChangeRequestAuthority,
  EvolutionValueDecisionAuthority,
} from './program-change-owner-contract.js';
import { eventForOwnerSnapshot } from './program-change-owner-event.js';
import {
  assertOwnerProgressCanAdvance,
  assertSnapshotIdentity,
  ownerProgressAlreadyLinked,
} from './program-change-snapshot.js';
import {
  type EvolutionChangeLineageV1,
  type ExactAssetVersionRefV1,
  projectEvolutionProgramLineage,
} from './program-lineage.js';

export type EvolutionProgramChangeResult =
  | EvolutionProgramServiceResult
  | { outcome: 'waiting'; projection: EvolutionProgramProjectionV1 }
  | {
      outcome: 'blocked';
      blockerReason: string;
      blockerRef?: ChangeRefs['caseRef'];
      projection: EvolutionProgramProjectionV1;
    };

export interface ProgramChangeDependencies {
  read(programId: string): Promise<EvolutionProgramEventEnvelopeV1[]>;
  project(events: readonly EvolutionProgramEventEnvelopeV1[]): EvolutionProgramProjectionV1;
  append(
    input: CommandBase,
    event: EvolutionProgramEventV1,
    commandDigest: string,
  ): Promise<EvolutionProgramServiceResult>;
  owner?: EvolutionChangeOwnerPort;
}

const digest = (kind: string, input: object): string =>
  createHash('sha256')
    .update(JSON.stringify({ kind, ...input }))
    .digest('hex');

function fail(message: string): never {
  throw new EvolutionProgramServiceError('invalid_command', message);
}

function assertOwnerStatus(value: unknown, allowed: readonly string[], label: string): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail(`canonical change owner returned an unsupported ${label} status`);
  }
}

function blockedByOwner(
  response: EvolutionChangeOwnerBlocked,
  projection: EvolutionProgramProjectionV1,
): EvolutionProgramChangeResult {
  if (response.reason.trim().length === 0) return fail('canonical change owner returned an empty blocker reason');
  return {
    outcome: 'blocked',
    blockerReason: response.reason,
    ...(response.blockerRef === undefined ? {} : { blockerRef: ownerTruthRefV1Schema.parse(response.blockerRef) }),
    projection,
  };
}

function owner(deps: ProgramChangeDependencies): EvolutionChangeOwnerPort {
  if (!deps.owner) {
    throw new EvolutionProgramServiceError(
      'owner_contract_unavailable',
      'F266/F313 change owner contract is unavailable',
    );
  }
  return deps.owner;
}

function assertRequestAuthority(value: EvolutionChangeRequestAuthority | undefined): EvolutionChangeRequestAuthority {
  if (
    !value ||
    [value.invocationId, value.userId, value.catId, value.threadId, value.originMessageId].some(
      (part) => typeof part !== 'string' || part.trim().length === 0,
    )
  ) {
    fail('change proposal requires authenticated invocation authority with an exact source message');
  }
  return value;
}

function assertValueDecisionAuthority(
  value: EvolutionValueDecisionAuthority | undefined,
): EvolutionValueDecisionAuthority {
  if (!value) {
    return fail('metabolism decision requires exact value-owner authority');
  }
  return value;
}

function exactTarget(value: unknown): ExactAssetVersionRefV1 {
  return exactAssetVersionRefV1Schema.parse(value) as ExactAssetVersionRefV1;
}

function sameAsset(left: ExactAssetVersionRefV1, right: ExactAssetVersionRefV1): boolean {
  return (
    left.ownerFeatureId === right.ownerFeatureId && left.assetKind === right.assetKind && left.assetId === right.assetId
  );
}

function duplicateBeforeOwner(
  events: readonly EvolutionProgramEventEnvelopeV1[],
  clientMessageId: string,
  commandDigest: string,
  deps: ProgramChangeDependencies,
): EvolutionProgramServiceResult | undefined {
  const previous = events.find((event) => event.clientMessageId === clientMessageId);
  if (!previous) return undefined;
  if (previous.commandDigest !== commandDigest) {
    throw new EvolutionProgramServiceError(
      'idempotency_collision',
      'client message id was reused for another change command',
    );
  }
  return { outcome: 'duplicate', projection: deps.project(events) };
}

function sequenceConflictBeforeOwner(
  input: CommandBase,
  projection: EvolutionProgramProjectionV1,
): EvolutionProgramServiceResult | undefined {
  if (input.expectedSequence === projection.program.sequence) return undefined;
  return {
    outcome: 'conflict',
    actualSequence: projection.program.sequence,
    projection,
  };
}

function currentChange(events: readonly EvolutionProgramEventEnvelopeV1[]): EvolutionChangeLineageV1 {
  const current = projectEvolutionProgramLineage(events).current;
  if (!current) return fail('the Program has no active F266/F313 change cycle');
  return current;
}

type OwnerDecisionReceipt = Exclude<
  Awaited<ReturnType<EvolutionChangeOwnerPort['recordMetabolismDecision']>>,
  { status: 'blocked' }
>;

function validateMetabolismReceipt(
  decision: Exclude<EvolutionCycleDecision, 'insufficient'>,
  receipt: OwnerDecisionReceipt,
  currentAssetVersion: ExactAssetVersionRefV1,
): ExactAssetVersionRefV1 | undefined {
  const assetVersion = receipt.assetVersionRef === undefined ? undefined : exactTarget(receipt.assetVersionRef);
  if (
    decision === 'no_change' &&
    (receipt.executionReceiptRef === undefined ||
      assetVersion === undefined ||
      refIdentity(assetVersion) !== refIdentity(currentAssetVersion))
  ) {
    fail('no_change requires owner receipt and unchanged exact asset version');
  }
  if (
    decision === 'rollback' &&
    (receipt.executionReceiptRef === undefined ||
      assetVersion === undefined ||
      !sameAsset(assetVersion, currentAssetVersion) ||
      refIdentity(assetVersion) === refIdentity(currentAssetVersion))
  ) {
    fail('rollback requires owner receipt and reverted exact asset version');
  }
  if (decision === 'sunset' && receipt.executionReceiptRef === undefined) {
    fail('sunset requires owner execution receipt');
  }
  return assetVersion;
}

export async function proposeEvolutionProgramChange(
  input: CommandBase & { requestAuthority?: EvolutionChangeRequestAuthority },
  deps: ProgramChangeDependencies,
): Promise<EvolutionProgramChangeResult> {
  const events = await deps.read(input.programId);
  const requestAuthority = assertRequestAuthority(input.requestAuthority);
  const commandDigest = digest('propose', input);
  const duplicate = duplicateBeforeOwner(events, input.clientMessageId, commandDigest, deps);
  if (duplicate) return duplicate;
  const projection = deps.project(events);
  const conflict = sequenceConflictBeforeOwner(input, projection);
  if (conflict) return conflict;
  if (projection.program.lifecycle !== 'active' || projection.program.stage !== 'awaiting_approval')
    return fail('change proposal requires active/awaiting_approval');
  const existing = projectEvolutionProgramLineage(events).current;
  if (
    existing &&
    existing.status !== 'rejected' &&
    existing.status !== 'withdrawn' &&
    existing.status !== 'superseded' &&
    existing.status !== 'target_drift'
  ) {
    return fail('the Program already has an active canonical change proposal');
  }
  const cycle = projection.cycles.at(-1);
  if (!cycle?.interventionLayerRef) return fail('change proposal requires an owner-backed intervention ref');
  const response = await owner(deps).requestApproval({
    programRef: { ownerFeatureId: 'F311', ownerStateRef: input.programId },
    cycleRef: {
      ownerFeatureId: 'F311',
      ownerStateRef: `evolution-cycle:${input.programId}:${projection.program.cycle}`,
    },
    interventionRef: cycle.interventionLayerRef,
    clientMessageId: input.clientMessageId,
    requestAuthority,
  });
  if (response.status === 'blocked') {
    return blockedByOwner(response, projection);
  }
  assertOwnerStatus(response.status, ['pending'], 'approval');
  if (response.ownerAuthorizationRef === undefined) {
    return fail('canonical change owner published no owner authorization for the exact mutation surface');
  }
  const event: EvolutionProgramEventV1 = {
    type: 'change_cycle_linked',
    caseRef: ownerTruthRefV1Schema.parse(response.caseRef),
    proposalRef: ownerTruthRefV1Schema.parse(response.proposalRef),
    ownerAuthorizationRef: ownerTruthRefV1Schema.parse(response.ownerAuthorizationRef),
    targetVersionRef: exactTarget(response.targetVersionRef),
  };
  return deps.append(input, event, commandDigest);
}

export async function syncEvolutionProgramChange(
  input: CommandBase,
  deps: ProgramChangeDependencies,
): Promise<EvolutionProgramChangeResult> {
  const events = await deps.read(input.programId);
  const commandDigest = digest('sync', input);
  const duplicate = duplicateBeforeOwner(events, input.clientMessageId, commandDigest, deps);
  if (duplicate) return duplicate;
  const projection = deps.project(events);
  const conflict = sequenceConflictBeforeOwner(input, projection);
  if (conflict) return conflict;
  if (projection.program.lifecycle !== 'active') return fail('change synchronization requires an active Program');
  const active = currentChange(events);
  const snapshot = await owner(deps).resolveChange({ caseRef: active.caseRef, proposalRef: active.proposalRef });
  if (snapshot.status === 'blocked') {
    return blockedByOwner(snapshot, projection);
  }
  assertOwnerStatus(
    snapshot.status,
    ['pending', 'approved', 'rejected', 'withdrawn', 'superseded', 'target_drift', 'mutated', 'no_change', 'outcome'],
    'snapshot',
  );
  assertSnapshotIdentity(snapshot, active);
  if (ownerProgressAlreadyLinked(snapshot, active)) return { outcome: 'waiting', projection };
  assertOwnerProgressCanAdvance(snapshot, active);
  if (snapshot.status === 'pending') return fail('canonical owner snapshot has no new progress');
  return deps.append(input, eventForOwnerSnapshot(snapshot, active, events), commandDigest);
}

export async function decideEvolutionProgramChange(
  input: CommandBase & {
    decision: Exclude<EvolutionCycleDecision, 'insufficient'>;
    decisionAuthority?: EvolutionValueDecisionAuthority;
  },
  deps: ProgramChangeDependencies,
): Promise<EvolutionProgramChangeResult> {
  const events = await deps.read(input.programId);
  const commandDigest = digest('decide', input);
  const duplicate = duplicateBeforeOwner(events, input.clientMessageId, commandDigest, deps);
  if (duplicate) return duplicate;
  const projection = deps.project(events);
  const conflict = sequenceConflictBeforeOwner(input, projection);
  if (conflict) return conflict;
  if (projection.program.lifecycle !== 'active' || projection.program.stage !== 'deciding')
    return fail('metabolism decision requires active/deciding');
  const decisionAuthority = assertValueDecisionAuthority(input.decisionAuthority);
  const active = currentChange(events);
  const current = projectEvolutionProgramLineage(events).current;
  if (
    current?.status !== 'outcome' ||
    current.interventionReceiptRef === undefined ||
    current.interventionKind === undefined ||
    current.assetVersionRef === undefined ||
    current.outcomeReceiptRef === undefined ||
    (current.interventionKind === 'changed' && current.loadedRuntimeRef === undefined) ||
    current.freshnessProofRef === undefined
  ) {
    return fail('metabolism decision requires a linked owner intervention and fresh outcome');
  }
  const receipt = await owner(deps).recordMetabolismDecision({
    programRef: { ownerFeatureId: 'F311', ownerStateRef: input.programId },
    cycleRef: {
      ownerFeatureId: 'F311',
      ownerStateRef: `evolution-cycle:${input.programId}:${projection.program.cycle}`,
    },
    caseRef: active.caseRef,
    proposalRef: active.proposalRef,
    outcomeReceiptRef: current.outcomeReceiptRef,
    decision: input.decision,
    clientMessageId: input.clientMessageId,
    decisionAuthority,
  });
  if (receipt.status === 'blocked') {
    return blockedByOwner(receipt, projection);
  }
  assertOwnerStatus(receipt.status, ['recorded', 'duplicate'], 'metabolism');
  const receiptAssetVersion = validateMetabolismReceipt(input.decision, receipt, current.assetVersionRef);
  const event: EvolutionProgramEventV1 = {
    type: 'decision_recorded',
    decision: input.decision,
    decisionRef: ownerTruthRefV1Schema.parse(receipt.decisionRef),
    ...(receipt.executionReceiptRef === undefined
      ? {}
      : { executionReceiptRef: ownerTruthRefV1Schema.parse(receipt.executionReceiptRef) }),
    ...(receiptAssetVersion === undefined ? {} : { assetVersionRef: receiptAssetVersion }),
  };
  return deps.append(input, event, commandDigest);
}
