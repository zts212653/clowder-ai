import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { QueuePrestartRetirementIntent } from '../../stores/ports/queued-message-custody.js';
import type { QueueEntry } from './InvocationQueue.js';
import type { QueuedMessageCustodyCoordinator } from './QueuedMessageCustodyCoordinator.js';

interface RetirementLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface PrestartGroupRetirementDeps {
  finalizeSupplement(entry: QueueEntry): Promise<boolean>;
  messageStore?: Pick<IMessageStore, 'markCanceled'>;
  queueCustodyCoordinator?: Pick<QueuedMessageCustodyCoordinator, 'persistEntry' | 'withdrawEntry'>;
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
  canRemoveProcessingGroupAcrossUsers(threadId: string, entryId: string): boolean;
  removeProcessingGroupAcrossUsers(threadId: string, entryId: string): QueueEntry[] | null;
}

function messageIds(entry: Pick<QueueEntry, 'messageId' | 'mergedMessageIds'>): string[] {
  return [entry.messageId, ...entry.mergedMessageIds].filter((messageId): messageId is string => !!messageId);
}

async function terminalizeMessages(
  entry: QueueEntry,
  deps: PrestartGroupRetirementDeps,
  terminalizedMessageIds: Set<string>,
): Promise<boolean> {
  if (!deps.messageStore) return true;
  for (const messageId of messageIds(entry)) {
    if (terminalizedMessageIds.has(messageId)) continue;
    try {
      const canceled = await deps.messageStore.markCanceled(messageId);
      terminalizedMessageIds.add(messageId);
      if (canceled?.deliveryTransitioned === true) {
        deps.emitMessageDeleted(entry.userId, entry.threadId, messageId);
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
 * Custody is last: if supplement or message truth cannot close, the durable
 * Queue carrier remains available for retry/restart recovery.
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
      await deps.queueCustodyCoordinator?.withdrawEntry(carrier);
    } catch (err) {
      deps.log.error({ err, entryId: carrier.id }, 'Failed to withdraw superseded Queue custody');
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
    const existingIntent = retirement.carriers.find((carrier) => carrier.prestartRetirement)?.prestartRetirement;
    const intent: QueuePrestartRetirementIntent = existingIntent ?? {
      id: `prestart-retirement:${retirement.threadId}:${retirement.entryId}:${retirement.barrier.startedAt}`,
      primaryEntryId: retirement.entryId,
      entryIds: retirement.carriers.map((carrier) => carrier.id),
      targetCatId: retirement.targetCatId,
      startedAt: retirement.barrier.startedAt,
    };
    if (
      retirement.carriers.some(
        (carrier) =>
          carrier.prestartRetirement !== undefined &&
          JSON.stringify(carrier.prestartRetirement) !== JSON.stringify(intent),
      )
    ) {
      deps.log.error(
        { threadId: retirement.threadId, entryId: retirement.entryId },
        'Refused divergent pre-start retirement intent',
      );
      return false;
    }

    const carriers = retirement.carriers.map((carrier) => ({
      ...carrier,
      prestartRetirement: { ...intent, entryIds: [...intent.entryIds] },
    }));
    const anchor = carriers.at(-1);
    const persistenceOrder = anchor ? [anchor, ...carriers.slice(0, -1)] : [];
    try {
      for (const carrier of persistenceOrder) {
        await deps.queueCustodyCoordinator?.persistEntry(carrier);
      }
    } catch (err) {
      deps.log.error(
        { err, threadId: retirement.threadId, entryId: retirement.entryId, retirementIntentId: intent.id },
        'Failed to persist pre-start retirement intent',
      );
      return false;
    }

    if (!(await terminalizePrestartProcessingGroup(carriers, deps))) return false;
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
    if (!input.queue.canRemoveProcessingGroupAcrossUsers(retirement.threadId, retirement.entryId)) {
      return false;
    }
  }
  for (const retirement of input.retirements) {
    if (!input.queue.removeProcessingGroupAcrossUsers(retirement.threadId, retirement.entryId)) {
      return false;
    }
  }
  for (const retirement of input.retirements) {
    if (input.slots.get(retirement.key) === retirement.barrier) input.slots.delete(retirement.key);
  }
  return true;
}
