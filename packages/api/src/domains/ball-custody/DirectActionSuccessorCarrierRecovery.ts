import type { QueueReceiptTargetState } from '@cat-cafe/shared';
import { actionSuccessorCarrierKey } from '../cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { QueuedMessageCustody } from '../cats/services/stores/ports/queued-message-custody.js';
import { projectQueueReceipt } from '../cats/services/stores/ports/queued-message-receipt.js';
import {
  type ActionSuccessorAdmissionInput,
  type ActionSuccessorFence,
  actionSuccessorFencesMatch,
  buildActionSuccessorFence,
} from './ActionSuccessorAdmissionContract.js';
import { canonicalizeActionTerminalPredicate } from './ActionTerminalPredicateCatalog.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';
import {
  confirmHandledExecutionsEnded,
  type ExecutionLineageReader,
  type ExecutionRecordReader,
} from './DirectActionSuccessorExecutionEvidence.js';

const LIVE_TARGET_STATES = new Set<QueueReceiptTargetState>(['queued', 'notified', 'awakened', 'seen', 'steering']);

type ObservedCarrierState = QueueReceiptTargetState | 'admitted';

export type DirectActionSuccessorCarrierUnavailableReason =
  | 'authority_mismatch'
  | 'carrier_missing'
  | 'carrier_terminal'
  | 'carrier_failed'
  | 'carrier_mixed'
  /** Handled, but the execution record does not prove that run really ended in success. */
  | 'execution_unconfirmed'
  /** The lease moved under this request (cancelled, completed, replaced, or still being refreshed). */
  | 'lease_changed'
  | 'lookup_failed';

export type DirectActionSuccessorCarrierDecision =
  | { disposition: 'live'; fence: ActionSuccessorFence }
  | { disposition: 'restart_interrupted'; fence: ActionSuccessorFence }
  /** The handled generation's execution ended; `fence` names that OLD generation, not the next one. */
  | { disposition: 'refresh_handled'; fence: ActionSuccessorFence }
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

/**
 * The CHILD invocation ids this carrier's own custody durably names as having handled `holder`: the F264 target
 * outcome and every handled delivery attempt. They are not InvocationRecord ids, only pointers into the durable
 * turn ledger; each is trusted only after its lineage reaches a record created from this exact carrier key.
 */
function handledChildInvocationIdsOf(custody: QueuedMessageCustody, holder: string): string[] {
  const ids = new Set<string>();
  const outcomeId = custody.targetOutcomeByCatId?.[holder]?.invocationId;
  if (outcomeId) ids.add(outcomeId);
  for (const attempt of custody.targetAttempts ?? []) {
    if (attempt.targetCatId === holder && attempt.state === 'handled' && attempt.invocationId) {
      ids.add(attempt.invocationId);
    }
  }
  return [...ids];
}

function observeCustody(
  message: StoredMessage,
  holders: readonly string[],
  fence: ActionSuccessorFence,
  observed: Map<string, Set<ObservedCarrierState>>,
  handledChildInvocationIds: Map<string, Set<string>>,
): void {
  const custody = message.queueCustody;
  if (!custody) return;
  const receipt = projectQueueReceipt(custody);
  for (const holder of holders) {
    const binding = custody.carrierByTargetCatId?.[holder];
    if (!actionSuccessorFencesMatch(binding?.actionSuccessorFence, fence)) continue;
    if (binding?.idempotencyKey !== actionSuccessorCarrierKey(fence, holder)) continue;
    const target = receipt.targets.find((candidate) => candidate.catId === holder);
    if (!target) continue;
    observed.get(holder)?.add(target.state);
    if (target.state === 'handled') {
      for (const id of handledChildInvocationIdsOf(custody, holder)) handledChildInvocationIds.get(holder)?.add(id);
    }
  }
}

interface CarrierObservation {
  decision: DirectActionSuccessorCarrierDecision;
  fence: ActionSuccessorFence;
  /** Every holder's only observed custody state is `handled` (no withdrawn / failed / live mixed in). */
  handledOnly: boolean;
  /** Per holder, the child invocation ids this exact carrier's custody names as having handled it. */
  handledChildInvocationIds: ReadonlyMap<string, ReadonlySet<string>>;
}

function observeDirectActionSuccessorCarrier(
  lease: ActionSuccessorLease,
  messages: readonly StoredMessage[],
): CarrierObservation {
  const fence = buildActionSuccessorFence(lease, lease.dispatchId);
  const observed = new Map(lease.holderCatIds.map((catId) => [catId, new Set<ObservedCarrierState>()]));
  const handledChildInvocationIds = new Map(lease.holderCatIds.map((catId) => [catId, new Set<string>()]));

  for (const message of messages) {
    if (message.threadId !== lease.holderThreadId || message.userId !== lease.tenantScope) continue;
    observeAdmission(message, lease.holderCatIds, fence, observed);
    observeCustody(message, lease.holderCatIds, fence, observed, handledChildInvocationIds);
  }

  const holderStates = lease.holderCatIds.map((catId) => observed.get(catId) ?? new Set<ObservedCarrierState>());
  const handledOnly = holderStates.every(
    (states) => states.size > 0 && [...states].every((state) => state === 'handled'),
  );
  const decide = (decision: DirectActionSuccessorCarrierDecision): CarrierObservation => ({
    decision,
    fence,
    handledOnly,
    handledChildInvocationIds,
  });
  const everyHolderLive = holderStates.every((states) =>
    [...states].some((state) => state === 'admitted' || LIVE_TARGET_STATES.has(state as QueueReceiptTargetState)),
  );
  if (everyHolderLive) return decide({ disposition: 'live', fence });

  const everyHolderRestartInterrupted = holderStates.every(
    (states) => states.size > 0 && [...states].every((state) => state === 'interrupted'),
  );
  if (everyHolderRestartInterrupted) return decide({ disposition: 'restart_interrupted', fence });

  if (holderStates.some((states) => states.size === 0)) {
    return decide({ disposition: 'unavailable', reason: 'carrier_missing' });
  }
  if (holderStates.some((states) => states.has('handled') || states.has('withdrawn'))) {
    return decide({ disposition: 'unavailable', reason: 'carrier_terminal' });
  }
  if (holderStates.some((states) => states.has('failed'))) {
    return decide({ disposition: 'unavailable', reason: 'carrier_failed' });
  }
  return decide({ disposition: 'unavailable', reason: 'carrier_mixed' });
}

/** Classify only durable, exact-fence custody; message recency and process state are irrelevant. */
export function classifyDirectActionSuccessorCarrier(
  lease: ActionSuccessorLease,
  messages: readonly StoredMessage[],
): DirectActionSuccessorCarrierDecision {
  return observeDirectActionSuccessorCarrier(lease, messages).decision;
}

/**
 * What the store can prove about a carrier message's Queue admission. `unverified` is its own state:
 * a failed read says nothing about whether the admission exists, so it must never be folded into
 * either answer.
 */
export type CarrierAdmissionEvidence = 'durable' | 'not_persisted' | 'unverified';

/**
 * Read back whether `messageId` really holds durable Queue custody (an admission or a custody carrier
 * binding) for exactly this fence and holder set. Startup reconciliation can restore a delivery only
 * from that durable record, so this, not the fact that delivery failed, decides what a caller may be told.
 */
export async function readCarrierAdmissionEvidence(
  messageStore: Pick<IMessageStore, 'getById'>,
  messageId: string,
  holderCatIds: readonly string[],
  fence: ActionSuccessorFence,
): Promise<CarrierAdmissionEvidence> {
  try {
    const message = await messageStore.getById(messageId);
    if (!message) return 'unverified';
    const admission = message.queueCustodyAdmission;
    const admitted =
      admission !== undefined &&
      actionSuccessorFencesMatch(admission.actionSuccessorFence, fence) &&
      sameMembers(holderCatIds, admission.targetCats);
    const bound = holderCatIds.every((holder) =>
      actionSuccessorFencesMatch(message.queueCustody?.carrierByTargetCatId?.[holder]?.actionSuccessorFence, fence),
    );
    return admitted || bound ? 'durable' : 'not_persisted';
  } catch {
    return 'unverified';
  }
}

export async function resolveDirectActionSuccessorCarrier(input: {
  messageStore: Pick<IMessageStore, 'getByThreadAfter'>;
  invocationRecordStore?: ExecutionRecordReader;
  /** The durable child ledger; without it a custody pointer cannot be followed and stays unconfirmed. */
  turnExecutionStore?: ExecutionLineageReader;
  lease: ActionSuccessorLease;
  admissionInput: ActionSuccessorAdmissionInput;
}): Promise<DirectActionSuccessorCarrierDecision> {
  if (!isExactDirectActionSuccessorReentry(input.lease, input.admissionInput)) {
    return { disposition: 'unavailable', reason: 'authority_mismatch' };
  }
  let messages: readonly StoredMessage[];
  try {
    messages = await input.messageStore.getByThreadAfter(
      input.lease.holderThreadId,
      undefined,
      undefined,
      input.lease.tenantScope,
      { includeQueuedCatMessages: true, includeQueuedUserMessages: true },
    );
  } catch {
    return { disposition: 'unavailable', reason: 'lookup_failed' };
  }
  const { decision, fence, handledOnly, handledChildInvocationIds } = observeDirectActionSuccessorCarrier(
    input.lease,
    messages,
  );
  const handledCarrier =
    decision.disposition === 'unavailable' && decision.reason === 'carrier_terminal' && handledOnly;
  return handledCarrier
    ? confirmHandledExecutionsEnded(
        input.lease,
        fence,
        { recordStore: input.invocationRecordStore, lineage: input.turnExecutionStore },
        handledChildInvocationIds,
      )
    : decision;
}
