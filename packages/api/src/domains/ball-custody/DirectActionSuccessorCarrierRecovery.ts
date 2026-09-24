import type { InvocationQueue } from '../cats/services/agents/invocation/InvocationQueue.js';
import type { QueueLedgerEntry } from '../cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import {
  type ActionSuccessorAdmissionInput,
  type ActionSuccessorFence,
  actionSuccessorFencesMatch,
  buildActionSuccessorFence,
} from './ActionSuccessorAdmissionContract.js';
import { canonicalizeActionTerminalPredicate } from './ActionTerminalPredicateCatalog.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

export type DirectActionSuccessorCarrierUnavailableReason =
  | 'authority_mismatch'
  | 'carrier_missing'
  | 'carrier_terminal'
  | 'carrier_failed'
  | 'carrier_mixed'
  | 'lookup_failed';

export type DirectActionSuccessorCarrierDecision =
  | { disposition: 'live'; fence: ActionSuccessorFence }
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

function observeLedgerEntry(
  entry: QueueLedgerEntry,
  holders: readonly string[],
  fence: ActionSuccessorFence,
  observed: Set<string>,
): void {
  if (!actionSuccessorFencesMatch(entry.execution.actionSuccessorFence, fence)) return;
  for (const targetId of entry.targets) {
    if (holders.includes(targetId)) observed.add(targetId);
  }
}

/** Classify only durable, exact-fence custody; message recency and process state are irrelevant. */
export function classifyDirectActionSuccessorCarrier(
  lease: ActionSuccessorLease,
  entries: readonly QueueLedgerEntry[],
): DirectActionSuccessorCarrierDecision {
  const fence = buildActionSuccessorFence(lease, lease.dispatchId);
  const observed = new Set<string>();

  for (const entry of entries) {
    const ownerUserId = entry.owner.kind === 'user' ? entry.owner.userId : `system:${entry.owner.service}`;
    if (entry.threadId !== lease.holderThreadId || ownerUserId !== lease.tenantScope) continue;
    observeLedgerEntry(entry, lease.holderCatIds, fence, observed);
  }

  return lease.holderCatIds.every((catId) => observed.has(catId))
    ? { disposition: 'live', fence }
    : { disposition: 'unavailable', reason: 'carrier_missing' };
}

export async function resolveDirectActionSuccessorCarrier(input: {
  invocationQueue: Pick<InvocationQueue, 'listAllDurable'>;
  lease: ActionSuccessorLease;
  admissionInput: ActionSuccessorAdmissionInput;
}): Promise<DirectActionSuccessorCarrierDecision> {
  if (!isExactDirectActionSuccessorReentry(input.lease, input.admissionInput)) {
    return { disposition: 'unavailable', reason: 'authority_mismatch' };
  }
  try {
    const entries = await input.invocationQueue.listAllDurable(input.lease.holderThreadId);
    return classifyDirectActionSuccessorCarrier(input.lease, entries);
  } catch {
    return { disposition: 'unavailable', reason: 'lookup_failed' };
  }
}
