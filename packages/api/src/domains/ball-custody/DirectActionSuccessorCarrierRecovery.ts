import type { QueueReceiptTargetState } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { projectQueueReceipt } from '../cats/services/stores/ports/queued-message-receipt.js';
import {
  type ActionSuccessorAdmissionInput,
  type ActionSuccessorFence,
  actionSuccessorFencesMatch,
  buildActionSuccessorFence,
} from './ActionSuccessorAdmissionContract.js';
import { canonicalizeActionTerminalPredicate } from './ActionTerminalPredicateCatalog.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

const LIVE_TARGET_STATES = new Set<QueueReceiptTargetState>(['queued', 'notified', 'awakened', 'seen', 'steering']);

type ObservedCarrierState = QueueReceiptTargetState | 'admitted';

export type DirectActionSuccessorCarrierUnavailableReason =
  | 'authority_mismatch'
  | 'carrier_missing'
  | 'carrier_terminal'
  | 'carrier_failed'
  | 'carrier_mixed'
  | 'lookup_failed';

export type DirectActionSuccessorCarrierDecision =
  | { disposition: 'live'; fence: ActionSuccessorFence }
  | { disposition: 'restart_interrupted'; fence: ActionSuccessorFence }
  | { disposition: 'unavailable'; reason: DirectActionSuccessorCarrierUnavailableReason };

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((value) => expected.has(value));
}

function expectedDirectDispatchPrefix(input: Pick<ActionSuccessorAdmissionInput, 'sourceThreadId' | 'targetThreadId'>) {
  return input.sourceThreadId === input.targetThreadId ? 'post:' : 'cross-post:';
}

/**
 * A new callback invocation may reuse an interrupted direct carrier only when
 * it exercises the exact authority already stored on the active generation.
 * The callback id and evidence ref are intentionally new; neither grants or
 * widens custody.
 */
export function isExactDirectActionSuccessorReentry(
  lease: ActionSuccessorLease,
  input: ActionSuccessorAdmissionInput,
): boolean {
  if (
    lease.status !== 'active' ||
    lease.claimOrigin !== 'structured_transfer' ||
    lease.dispatchDeliveryState !== undefined ||
    !lease.dispatchId.startsWith(expectedDirectDispatchPrefix(input)) ||
    !input.dispatchId.startsWith(expectedDirectDispatchPrefix(input)) ||
    input.action.replace !== undefined ||
    input.action.returnToPredecessor !== undefined ||
    (input.action.claimOrigin ?? 'structured_transfer') !== 'structured_transfer' ||
    Object.keys(lease.holderOutcomes).length > 0 ||
    Object.keys(lease.completionCandidates).length > 0 ||
    lease.tenantScope !== input.tenantScope ||
    lease.actionFamily !== input.action.actionFamily ||
    lease.successorSlot !== input.action.successorSlot ||
    lease.predecessorCatId !== input.actorCatId ||
    lease.predecessorThreadId !== input.sourceThreadId ||
    lease.holderThreadId !== input.targetThreadId ||
    lease.mode !== input.action.mode ||
    (lease.parallelIntent?.trim() || undefined) !== (input.action.parallelIntent?.trim() || undefined) ||
    !sameMembers(lease.holderCatIds, input.holderCatIds) ||
    !lease.terminalPredicate ||
    !input.action.terminalPredicate
  ) {
    return false;
  }

  try {
    const incoming = canonicalizeActionTerminalPredicate({
      actionFamily: input.action.actionFamily,
      subjectRef: input.action.subjectRef,
      predicate: input.action.terminalPredicate,
    });
    return incoming.subjectRef === lease.subjectRef && incoming.digest === lease.terminalPredicate.digest;
  } catch {
    return false;
  }
}

function observeAdmission(
  message: StoredMessage,
  holders: readonly string[],
  fence: ActionSuccessorFence,
  observed: Map<string, Set<ObservedCarrierState>>,
): void {
  const admission = message.queueCustodyAdmission;
  if (!admission || !actionSuccessorFencesMatch(admission.actionSuccessorFence, fence)) return;
  if (!sameMembers(holders, admission.targetCats)) return;
  for (const holder of holders) {
    if (admission.targetCats.includes(holder as (typeof admission.targetCats)[number])) {
      observed.get(holder)?.add('admitted');
    }
  }
}

function observeCustody(
  message: StoredMessage,
  holders: readonly string[],
  fence: ActionSuccessorFence,
  observed: Map<string, Set<ObservedCarrierState>>,
): void {
  const custody = message.queueCustody;
  if (!custody) return;
  const receipt = projectQueueReceipt(custody);
  for (const holder of holders) {
    const binding = custody.carrierByTargetCatId?.[holder];
    if (!actionSuccessorFencesMatch(binding?.actionSuccessorFence, fence)) continue;
    if (binding?.idempotencyKey !== `action:${fence.leaseId}:${fence.generation}:${holder}`) continue;
    const target = receipt.targets.find((candidate) => candidate.catId === holder);
    if (target) observed.get(holder)?.add(target.state);
  }
}

/** Classify only durable, exact-fence custody; message recency and process state are irrelevant. */
export function classifyDirectActionSuccessorCarrier(
  lease: ActionSuccessorLease,
  messages: readonly StoredMessage[],
): DirectActionSuccessorCarrierDecision {
  const fence = buildActionSuccessorFence(lease, lease.dispatchId);
  const observed = new Map(lease.holderCatIds.map((catId) => [catId, new Set<ObservedCarrierState>()]));

  for (const message of messages) {
    if (message.threadId !== lease.holderThreadId || message.userId !== lease.tenantScope) continue;
    observeAdmission(message, lease.holderCatIds, fence, observed);
    observeCustody(message, lease.holderCatIds, fence, observed);
  }

  const holderStates = lease.holderCatIds.map((catId) => observed.get(catId) ?? new Set<ObservedCarrierState>());
  const everyHolderLive = holderStates.every((states) =>
    [...states].some((state) => state === 'admitted' || LIVE_TARGET_STATES.has(state as QueueReceiptTargetState)),
  );
  if (everyHolderLive) return { disposition: 'live', fence };

  const everyHolderRestartInterrupted = holderStates.every(
    (states) => states.size > 0 && [...states].every((state) => state === 'interrupted'),
  );
  if (everyHolderRestartInterrupted) return { disposition: 'restart_interrupted', fence };

  if (holderStates.some((states) => states.size === 0)) {
    return { disposition: 'unavailable', reason: 'carrier_missing' };
  }
  if (holderStates.some((states) => states.has('handled') || states.has('withdrawn'))) {
    return { disposition: 'unavailable', reason: 'carrier_terminal' };
  }
  if (holderStates.some((states) => states.has('failed'))) {
    return { disposition: 'unavailable', reason: 'carrier_failed' };
  }
  return { disposition: 'unavailable', reason: 'carrier_mixed' };
}

export async function resolveDirectActionSuccessorCarrier(input: {
  messageStore: Pick<IMessageStore, 'getByThreadAfter'>;
  lease: ActionSuccessorLease;
  admissionInput: ActionSuccessorAdmissionInput;
}): Promise<DirectActionSuccessorCarrierDecision> {
  if (!isExactDirectActionSuccessorReentry(input.lease, input.admissionInput)) {
    return { disposition: 'unavailable', reason: 'authority_mismatch' };
  }
  try {
    const messages = await input.messageStore.getByThreadAfter(
      input.lease.holderThreadId,
      undefined,
      undefined,
      input.lease.tenantScope,
      { includeQueuedCatMessages: true, includeQueuedUserMessages: true },
    );
    return classifyDirectActionSuccessorCarrier(input.lease, messages);
  } catch {
    return { disposition: 'unavailable', reason: 'lookup_failed' };
  }
}
