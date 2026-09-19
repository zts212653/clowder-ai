import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import { type QueueEntry, queueEntryMessageIds, queueEntryOwnerId } from './InvocationQueue.js';

interface RetirementLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface PrestartGroupRetirementDeps {
  finalizeSupplement(entry: QueueEntry): Promise<boolean>;
  messageStore?: Pick<IMessageStore, 'markCanceled'>;
  shouldCancelMessage(entry: QueueEntry, messageId: string): boolean;
  commitCarrier(entry: QueueEntry): Promise<boolean>;
  emitMessageDeleted(userId: string, threadId: string, messageId: string): void;
  log: RetirementLogger;
}

export interface PrestartRetirementReservation {
  readonly startedAt: number;
  readonly entryId: string;
  readonly userId: string;
  invocationId?: string;
  trackerStarted?: true;
  retirementBarrier?: true;
}

export interface PreparedPrestartRetirement {
  readonly key: string;
  readonly barrier: PrestartRetirementReservation;
  readonly threadId: string;
  readonly targetCatId: string;
  readonly entryId: string;
  readonly carriers: readonly QueueEntry[];
}

interface ProcessingGroupPort {
  getProcessingGroupAcrossUsers(threadId: string, entryId: string): QueueEntry[] | null;
}

async function terminalizeMessages(
  entry: QueueEntry,
  deps: PrestartGroupRetirementDeps,
  terminalizedMessageIds: Set<string>,
): Promise<boolean> {
  if (!deps.messageStore) return true;
  for (const messageId of queueEntryMessageIds(entry)) {
    if (terminalizedMessageIds.has(messageId)) continue;
    if (!deps.shouldCancelMessage(entry, messageId)) continue;
    try {
      const canceled = await deps.messageStore.markCanceled(messageId);
      terminalizedMessageIds.add(messageId);
      if (canceled?.deliveryTransitioned === true) {
        deps.emitMessageDeleted(queueEntryOwnerId(entry), entry.threadId, messageId);
      }
    } catch (err) {
      deps.log.error({ err, messageId, entryId: entry.id }, 'Failed to cancel superseded Queue message');
      return false;
    }
  }
  return true;
}

/**
 * Terminalize one still-visible processing group in durable dependency order.
 * The ledger terminal commit is last: if supplement or message truth cannot
 * close, the claimed Queue row remains available for deterministic recovery.
 */
export async function terminalizePrestartProcessingGroup(
  carriers: readonly QueueEntry[],
  deps: PrestartGroupRetirementDeps,
): Promise<boolean> {
  const terminalizedMessageIds = new Set<string>();
  for (const carrier of carriers) {
    if (!(await deps.finalizeSupplement(carrier))) return false;
    if (!(await terminalizeMessages(carrier, deps, terminalizedMessageIds))) return false;
    try {
      if (!(await deps.commitCarrier(carrier))) throw new Error('ledger state changed');
    } catch (err) {
      deps.log.error({ err, entryId: carrier.id }, 'Failed to withdraw superseded Queue entry');
      return false;
    }
  }
  return true;
}

export async function terminalizePreparedPrestartRetirements(
  retirements: readonly PreparedPrestartRetirement[],
  deps: PrestartGroupRetirementDeps,
): Promise<boolean> {
  for (const retirement of retirements) {
    if (!(await terminalizePrestartProcessingGroup(retirement.carriers, deps))) return false;
  }
  return true;
}

/** Install all barriers before the first durable await. */
export function preparePrestartRetirements(input: {
  slots: Map<string, PrestartRetirementReservation>;
  queue: ProcessingGroupPort;
  threadId: string;
  catIds: readonly string[];
  userId: string;
  slotKey(threadId: string, catId: string): string;
}): PreparedPrestartRetirement[] | null {
  const observed: Array<{
    key: string;
    targetCatId: string;
    current: PrestartRetirementReservation;
    carriers: readonly QueueEntry[];
  }> = [];
  const seenEntryIds = new Set<string>();

  for (const catId of new Set(input.catIds)) {
    const key = input.slotKey(input.threadId, catId);
    const current = input.slots.get(key);
    if (!current) continue;
    if (current.userId !== input.userId) return null;
    if (seenEntryIds.has(current.entryId)) continue;
    const carriers = input.queue.getProcessingGroupAcrossUsers(input.threadId, current.entryId);
    if (!carriers) return null;
    seenEntryIds.add(current.entryId);
    observed.push({ key, targetCatId: catId, current, carriers });
  }

  return observed.map(({ key, targetCatId, current, carriers }) => {
    if (current.retirementBarrier) {
      return { key, targetCatId, barrier: current, threadId: input.threadId, entryId: current.entryId, carriers };
    }
    const barrier: PrestartRetirementReservation = {
      startedAt: current.startedAt,
      entryId: current.entryId,
      userId: current.userId,
      ...(current.invocationId ? { invocationId: current.invocationId } : {}),
      retirementBarrier: true,
    };
    input.slots.set(key, barrier);
    return { key, targetCatId, barrier, threadId: input.threadId, entryId: current.entryId, carriers };
  });
}

/** Remove rows and release barriers in one await-free commit section. */
export function commitPreparedPrestartRetirements(input: {
  retirements: readonly PreparedPrestartRetirement[];
  slots: Map<string, PrestartRetirementReservation>;
  queue: ProcessingGroupPort;
}): boolean {
  for (const retirement of input.retirements) {
    if (input.slots.get(retirement.key) !== retirement.barrier) return false;
    if (input.queue.getProcessingGroupAcrossUsers(retirement.threadId, retirement.entryId)) return false;
  }
  for (const retirement of input.retirements) {
    if (input.slots.get(retirement.key) === retirement.barrier) input.slots.delete(retirement.key);
  }
  return true;
}
