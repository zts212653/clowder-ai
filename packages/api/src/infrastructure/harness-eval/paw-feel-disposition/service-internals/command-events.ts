import type { PawFeelDispositionActor, PawFeelDispositionEvent } from '@cat-cafe/shared';
import type { PawFeelDispositionCommand, PawFeelResolvedCommandContext } from '../commands.js';

type Actor = Extract<PawFeelDispositionActor, { kind: 'cat' | 'cvo' }>;
type EventBase = Pick<PawFeelDispositionEvent, 'eventId' | 'signalId' | 'actor' | 'occurredAt'>;

function ownedTerminalEvent(
  base: EventBase,
  command: Extract<PawFeelDispositionCommand, { type: 'mark_duplicate' | 'mark_no_action' }>,
  context: PawFeelResolvedCommandContext,
): PawFeelDispositionEvent {
  if (!context.ownerCatId) throw new Error(`${command.type} requires named owner`);
  return command.type === 'mark_duplicate'
    ? { ...base, type: 'duplicate', duplicateOf: command.duplicateOf, ownerCatId: context.ownerCatId }
    : { ...base, type: 'no_action', reasonCode: command.reasonCode, ownerCatId: context.ownerCatId };
}

function fixEvent(
  base: EventBase,
  context: PawFeelResolvedCommandContext,
): Extract<PawFeelDispositionEvent, { type: 'fix' }> {
  if (!context.fix || !context.directRepairBinding) {
    throw new Error('fix requires verified task, active lease, and direct repair authority');
  }
  return {
    ...base,
    type: 'fix',
    ownerCatId: context.fix.ownerCatId,
    taskId: context.fix.taskId,
    leaseId: context.fix.leaseId,
    leaseGeneration: context.fix.leaseGeneration,
    custodyEvidenceRef: context.fix.custodyEvidenceRef,
    directRepairBinding: context.directRepairBinding,
  };
}

function signatureEvent(
  base: EventBase,
  command: Extract<PawFeelDispositionCommand, { type: 'request_signature' }>,
  context: PawFeelResolvedCommandContext,
): Extract<PawFeelDispositionEvent, { type: 'signature_requested' }> {
  if (!context.signatureAction) throw new Error('signature request requires a resolved action');
  return {
    ...base,
    type: 'signature_requested',
    action: context.signatureAction,
    ...(command.preferredSignerCatId ? { preferredSignerCatId: command.preferredSignerCatId } : {}),
  };
}

export function pawFeelCommandToEvent(
  actor: Actor,
  command: PawFeelDispositionCommand,
  occurredAt: string,
  context: PawFeelResolvedCommandContext = {},
): PawFeelDispositionEvent {
  const base = { eventId: command.eventId, signalId: command.signalId, actor, occurredAt };
  switch (command.type) {
    case 'mark_seen':
      return { ...base, type: 'seen' };
    case 'route_pending':
      return {
        ...base,
        type: 'route_pending',
        ...(command.targetThreadId ? { targetThreadId: command.targetThreadId } : {}),
        ...(command.ownerEvidenceRef ? { ownerEvidenceRef: command.ownerEvidenceRef } : {}),
        ...(command.proposalId ? { proposalId: command.proposalId } : {}),
      };
    case 'confirm_routed':
      return {
        ...base,
        type: 'routed',
        receiptRef: command.receiptRef,
        ...(command.targetThreadId ? { targetThreadId: command.targetThreadId } : {}),
        ...(command.proposalId ? { proposalId: command.proposalId } : {}),
      };
    case 'route_reopened':
      return { ...base, type: 'route_reopened', rejectionRef: command.rejectionRef, reasonCode: command.reasonCode };
    case 'close':
      return { ...base, type: 'closed', reasonCode: command.reasonCode, outcomeRef: command.outcomeRef };
    case 'mark_duplicate':
    case 'mark_no_action':
      return ownedTerminalEvent(base, command, context);
    case 'mark_fix':
      return fixEvent(base, context);
    case 'link_repair_outcome':
      if (!context.repairOutcome) throw new Error('repair outcome requires owner verification');
      return { ...base, type: 'repair_outcome_linked', outcome: context.repairOutcome };
    case 'request_signature':
      return signatureEvent(base, command, context);
    case 'mark_blocked':
      if (!context.resumeCondition) throw new Error('new blocker requires a resolved resume condition');
      return {
        ...base,
        type: 'blocked',
        blockerCode: command.blockerCode,
        blockerRef: command.blockerRef,
        resumeCondition: context.resumeCondition,
      };
  }
}
