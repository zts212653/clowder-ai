import { type PawFeelDispositionEvent, refIdentity } from '@cat-cafe/shared';
import type { PawFeelDispositionCommand, PawFeelResolvedCommandContext } from '../commands.js';
import { PawFeelDispositionServiceError } from '../service-guards.js';

function expectedEventType(command: PawFeelDispositionCommand): PawFeelDispositionEvent['type'] {
  switch (command.type) {
    case 'mark_seen':
      return 'seen';
    case 'route_pending':
      return 'route_pending';
    case 'confirm_routed':
      return 'routed';
    case 'route_reopened':
      return 'route_reopened';
    case 'close':
      return 'closed';
    case 'mark_duplicate':
      return 'duplicate';
    case 'mark_no_action':
      return 'no_action';
    case 'mark_fix':
      return 'fix';
    case 'link_repair_outcome':
      return 'repair_outcome_linked';
    case 'request_signature':
      return 'signature_requested';
    case 'mark_blocked':
      return 'blocked';
  }
}

function collision(eventId: string, detail: string): never {
  throw new PawFeelDispositionServiceError('idempotency_collision', `idempotency collision for ${eventId}: ${detail}`);
}

function replayFix(
  command: Extract<PawFeelDispositionCommand, { type: 'mark_fix' }>,
  existing: Extract<PawFeelDispositionEvent, { type: 'fix' }>,
): PawFeelResolvedCommandContext {
  if (existing.leaseId !== command.leaseId || !existing.directRepairBinding) {
    return collision(command.eventId, 'stored fix does not match the requested direct-repair lease');
  }
  return {
    fix: {
      ownerCatId: existing.ownerCatId,
      taskId: existing.taskId,
      leaseId: existing.leaseId,
      leaseGeneration: existing.leaseGeneration,
      custodyEvidenceRef: existing.custodyEvidenceRef,
    },
    directRepairBinding: existing.directRepairBinding,
  };
}

function replaySignature(
  command: Extract<PawFeelDispositionCommand, { type: 'request_signature' }>,
  existing: Extract<PawFeelDispositionEvent, { type: 'signature_requested' }>,
): PawFeelResolvedCommandContext {
  if (command.action.type !== 'fix') return { signatureAction: existing.action };
  if (
    existing.action.type !== 'fix' ||
    existing.action.leaseId !== command.action.leaseId ||
    !existing.action.directRepairBinding
  ) {
    return collision(command.eventId, 'stored signature request does not match the direct-repair lease');
  }
  return { signatureAction: existing.action };
}

function replayOutcome(
  command: Extract<PawFeelDispositionCommand, { type: 'link_repair_outcome' }>,
  existing: Extract<PawFeelDispositionEvent, { type: 'repair_outcome_linked' }>,
): PawFeelResolvedCommandContext {
  if (
    refIdentity(existing.outcome.bindingRef) !== refIdentity(command.bindingRef) ||
    refIdentity(existing.outcome.ownerOutcomeRef) !== refIdentity(command.ownerOutcomeRef)
  ) {
    return collision(command.eventId, 'stored repair outcome refs differ from the retry');
  }
  return { repairOutcome: existing.outcome };
}

function replayBlocker(
  command: Extract<PawFeelDispositionCommand, { type: 'mark_blocked' }>,
  existing: Extract<PawFeelDispositionEvent, { type: 'blocked' }>,
): PawFeelResolvedCommandContext {
  if (
    !existing.resumeCondition ||
    JSON.stringify(existing.resumeCondition.selector) !== JSON.stringify(command.resume)
  ) {
    return collision(command.eventId, 'stored blocker selector differs from the retry');
  }
  return { resumeCondition: existing.resumeCondition };
}

function replayOwnedTerminal(
  command: Extract<PawFeelDispositionCommand, { type: 'mark_duplicate' | 'mark_no_action' }>,
  existing: Extract<PawFeelDispositionEvent, { type: 'duplicate' | 'no_action' }>,
): PawFeelResolvedCommandContext {
  const ownerCatId = existing.ownerCatId ?? (existing.actor.kind === 'cat' ? existing.actor.id : undefined);
  if (!ownerCatId) return collision(command.eventId, `stored ${existing.type} has no replayable owner`);
  return { ownerCatId };
}

export function resolvePawFeelReplayContext(
  command: PawFeelDispositionCommand,
  existing?: PawFeelDispositionEvent,
): PawFeelResolvedCommandContext | undefined {
  if (!existing) return undefined;
  if (existing.type !== expectedEventType(command)) {
    return collision(command.eventId, `stored ${existing.type} differs from requested ${command.type}`);
  }
  if (command.type === 'mark_fix') return replayFix(command, existing as Extract<typeof existing, { type: 'fix' }>);
  if (command.type === 'request_signature') {
    return replaySignature(command, existing as Extract<typeof existing, { type: 'signature_requested' }>);
  }
  if (command.type === 'link_repair_outcome') {
    return replayOutcome(command, existing as Extract<typeof existing, { type: 'repair_outcome_linked' }>);
  }
  if (command.type === 'mark_blocked') {
    return replayBlocker(command, existing as Extract<typeof existing, { type: 'blocked' }>);
  }
  if (command.type === 'mark_duplicate' || command.type === 'mark_no_action') {
    return replayOwnedTerminal(command, existing as Extract<typeof existing, { type: 'duplicate' | 'no_action' }>);
  }
  return {};
}
