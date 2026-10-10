import type { InvocationQueue } from '../cats/services/agents/invocation/InvocationQueue.js';
import type { QueueLedgerEntry } from '../cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import {
  type ActionSuccessorAdmissionInput,
  type ActionSuccessorFence,
  actionSuccessorFencesMatch,
  buildActionSuccessorFence,
} from './ActionSuccessorAdmissionContract.js';
import { canonicalizeActionTerminalPredicate } from './ActionTerminalPredicateCatalog.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';
import {
  type ActionHistoryExecutionState,
  type ExecutionLineageReader,
  type ExecutionRecordReader,
  readActionHistoryExecution,
} from './DirectActionSuccessorExecutionEvidence.js';

export type DirectActionSuccessorCarrierUnavailableReason =
  | 'authority_mismatch'
  | 'carrier_missing'
  | 'carrier_terminal'
  | 'carrier_failed'
  | 'carrier_mixed'
  | 'execution_unconfirmed'
  | 'lease_changed'
  | 'lookup_failed';
export type DirectActionSuccessorCarrierDecision =
  | { disposition: 'live'; fence: ActionSuccessorFence }
  | { disposition: 'restart_interrupted'; fence: ActionSuccessorFence }
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

function exactPendingEntries(lease: ActionSuccessorLease, entries: readonly QueueLedgerEntry[]): QueueLedgerEntry[] {
  const fence = buildActionSuccessorFence(lease, lease.dispatchId);
  return entries.filter(
    (entry) =>
      entry.threadId === lease.holderThreadId &&
      entry.owner.kind === 'user' &&
      entry.owner.userId === lease.tenantScope &&
      entry.status !== 'terminal' &&
      actionSuccessorFencesMatch(entry.execution.actionSuccessorFence, fence),
  );
}

/** Pending-only projection. A missing Queue row is never terminal success. */
export function classifyDirectActionSuccessorCarrier(
  lease: ActionSuccessorLease,
  entries: readonly QueueLedgerEntry[],
): DirectActionSuccessorCarrierDecision {
  const pending = new Set(exactPendingEntries(lease, entries).flatMap((entry) => entry.targets));
  return lease.holderCatIds.every((holder) => pending.has(holder))
    ? { disposition: 'live', fence: buildActionSuccessorFence(lease, lease.dispatchId) }
    : { disposition: 'unavailable', reason: 'carrier_missing' };
}

export type CarrierAdmissionEvidence = 'durable' | 'not_persisted' | 'unverified';

/** Read canonical pending admission only; receipt shadows cannot promise startup recovery. */
export async function readCarrierAdmissionEvidence(
  queue: Pick<InvocationQueue, 'getDurableEntriesForMessages'>,
  messageId: string,
  holderCatIds: readonly string[],
  fence: ActionSuccessorFence,
  scope: { threadId: string; userId: string },
): Promise<CarrierAdmissionEvidence> {
  try {
    const entries = (await queue.getDurableEntriesForMessages(scope.threadId, [messageId])).get(messageId) ?? [];
    const pending = new Set(
      entries
        .filter(
          (entry) =>
            entry.threadId === scope.threadId &&
            entry.owner.kind === 'user' &&
            entry.owner.userId === scope.userId &&
            entry.payload.messageId === messageId &&
            entry.status !== 'terminal' &&
            actionSuccessorFencesMatch(entry.execution.actionSuccessorFence, fence),
        )
        .flatMap((entry) => entry.targets),
    );
    return holderCatIds.length > 0 && holderCatIds.every((holder) => pending.has(holder)) ? 'durable' : 'not_persisted';
  } catch {
    return 'unverified';
  }
}

function decideObservedExecutions(
  lease: ActionSuccessorLease,
  states: ReadonlyMap<string, ReadonlySet<ActionHistoryExecutionState>>,
): DirectActionSuccessorCarrierDecision {
  const observed = lease.holderCatIds.map((holder) => states.get(holder) ?? new Set<ActionHistoryExecutionState>());
  // A proven old interruption does not outrank an exact replacement source. No timestamp
  // establishes succession, and canceled/failed attempts remain terminal refusals.
  const all = (state: ActionHistoryExecutionState) =>
    observed.length > 0 &&
    observed.every(
      (values) => values.has(state) && [...values].every((value) => value === state || value === 'interrupted'),
    );
  const fence = buildActionSuccessorFence(lease, lease.dispatchId);
  if (observed.some((values) => values.has('canceled')))
    return { disposition: 'unavailable', reason: 'carrier_terminal' };
  if (observed.some((values) => values.has('failed'))) return { disposition: 'unavailable', reason: 'carrier_failed' };
  if (observed.some((values) => values.has('unconfirmed')))
    return { disposition: 'unavailable', reason: 'execution_unconfirmed' };
  if (all('live')) return { disposition: 'live', fence };
  if (all('interrupted')) return { disposition: 'restart_interrupted', fence };
  if (all('handled')) return { disposition: 'refresh_handled', fence };
  return {
    disposition: 'unavailable',
    reason: observed.some((values) => values.size === 0) ? 'carrier_missing' : 'carrier_mixed',
  };
}

function isPredecessorSource(
  source: Awaited<ReturnType<IMessageStore['getByThreadAfter']>>[number],
  lease: ActionSuccessorLease,
) {
  return (
    source.userId === lease.tenantScope &&
    source.threadId === lease.holderThreadId &&
    source.from?.kind === 'agent' &&
    source.from.catId === lease.predecessorCatId
  );
}

interface CarrierRecoveryInput {
  invocationQueue: Pick<InvocationQueue, 'listAllDurable'>;
  messageStore?: Pick<IMessageStore, 'getByThreadAfter' | 'getById'>;
  invocationRecordStore?: ExecutionRecordReader;
  turnExecutionStore?: ExecutionLineageReader;
  lease: ActionSuccessorLease;
  admissionInput: ActionSuccessorAdmissionInput;
}

const sourceKey = (holder: string, messageId: string) => JSON.stringify([holder, messageId]);

async function observeHistoryExecutions(
  input: CarrierRecoveryInput,
  pendingSources: ReadonlySet<string>,
  states: Map<string, Set<ActionHistoryExecutionState>>,
): Promise<Set<string>> {
  const historySources = new Set<string>();
  if (!input.messageStore) return historySources;
  const { lease } = input;
  const sources = await input.messageStore.getByThreadAfter(
    lease.holderThreadId,
    undefined,
    undefined,
    lease.tenantScope,
    { includeQueuedCatMessages: true, includeQueuedUserMessages: true },
  );
  for (const source of sources) {
    if (!isPredecessorSource(source, lease)) continue;
    for (const ref of source.lifecycle?.dispatchRefs ?? []) {
      if (!states.has(ref.targetId)) continue;
      const state = await readActionHistoryExecution({
        lease,
        source,
        holder: ref.targetId,
        responseMessageId: ref.statusMessageId,
        messages: input.messageStore,
        recordStore: input.invocationRecordStore,
        lineage: input.turnExecutionStore,
      });
      const identity = sourceKey(ref.targetId, source.id);
      if (state || pendingSources.has(identity)) {
        historySources.add(identity);
        states.get(ref.targetId)?.add(state ?? 'unconfirmed');
      }
    }
  }
  return historySources;
}

/**
 * QueueLedger is the only pending owner. History plus immutable child/parent execution records
 * proves actual delivery and terminal outcomes. This read-only join admits nothing.
 */
export async function resolveDirectActionSuccessorCarrier(
  input: CarrierRecoveryInput,
): Promise<DirectActionSuccessorCarrierDecision> {
  const { lease } = input;
  if (!isExactDirectActionSuccessorReentry(lease, input.admissionInput))
    return { disposition: 'unavailable', reason: 'authority_mismatch' };
  try {
    const entries = await input.invocationQueue.listAllDurable(lease.holderThreadId);
    const pending = exactPendingEntries(lease, entries);
    const pendingSources = new Set(
      pending.flatMap((entry) => entry.targets.map((holder) => sourceKey(holder, entry.payload.sourceRecordId))),
    );
    const states = new Map(lease.holderCatIds.map((holder) => [holder, new Set<ActionHistoryExecutionState>()]));
    const historySources = await observeHistoryExecutions(input, pendingSources, states);
    // Actual History wins over stale pending caches; unknown lineage never proves success.
    for (const entry of pending)
      for (const holder of entry.targets)
        if (!historySources.has(sourceKey(holder, entry.payload.sourceRecordId))) states.get(holder)?.add('live');
    return decideObservedExecutions(lease, states);
  } catch {
    return { disposition: 'unavailable', reason: 'lookup_failed' };
  }
}
