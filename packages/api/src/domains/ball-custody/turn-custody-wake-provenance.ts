import { isManagedHoldConnectorSource, type WaitContinuationCarrierV1 } from '@cat-cafe/shared';
import { type QueueEntry, queueEntryCallerCatId } from '../cats/services/agents/invocation/InvocationQueue.js';
import { hydrateCrossThreadReplyHint, type IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import { handedEventSourceId } from './ball-custody-events.js';
import type { TurnCustodyWakeProvenance } from './TurnCustodyProjectionService.js';
import {
  waitContinuationCarrierFromStoredMessage,
  waitContinuationCarriersMatch,
} from './wait-continuation-carrier.js';

type WakeQueueEntry = Pick<QueueEntry, 'execution' | 'from' | 'payload' | 'sourceCategory' | 'targets' | 'threadId'>;

function exactTargetCatId(entry: WakeQueueEntry): string | undefined {
  return entry.targets.length === 1 ? entry.targets[0] : undefined;
}

export function buildCrossThreadNoObligationWake(input: unknown): TurnCustodyWakeProvenance | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const coordination =
    record.coordination && typeof record.coordination === 'object' && !Array.isArray(record.coordination)
      ? (record.coordination as Record<string, unknown>)
      : undefined;
  if (coordination?.phase === 'terminal') {
    return { kind: 'non_obligation', source: 'coordination_terminal' };
  }
  if (record.effectClass === 'fyi') {
    return { kind: 'non_obligation', source: 'cross_thread_fyi' };
  }
  if (record.effectClass === 'coordinate') {
    return { kind: 'non_obligation', source: 'cross_thread_coordinate' };
  }
  return undefined;
}

export function buildA2ADispatchTurnCustodyWake(input: {
  readonly threadId: string;
  readonly targetCatId: string | undefined;
  readonly messageId: string | null | undefined;
  readonly fromCatId: string | null | undefined;
}): TurnCustodyWakeProvenance {
  if (!input.threadId || !input.targetCatId || !input.messageId || !input.fromCatId) {
    return { kind: 'legacy', reason: 'carrier_missing', sourceCategory: 'a2a' };
  }
  return {
    kind: 'structured',
    protocol: 'dispatch',
    subjectKey: `ball:thread:${input.threadId}`,
    holderCatId: input.targetCatId,
    handoff: {
      sourceEventId: handedEventSourceId(input.messageId, input.targetCatId),
      messageId: input.messageId,
      fromCatId: input.fromCatId,
    },
  };
}

export function retargetTurnCustodyWake(
  wake: TurnCustodyWakeProvenance,
  targetCatId: string,
): TurnCustodyWakeProvenance {
  if (wake.kind === 'structured' && wake.protocol === 'dispatch') {
    const threadSubjectPrefix = 'ball:thread:';
    if (!wake.subjectKey.startsWith(threadSubjectPrefix)) {
      return { kind: 'legacy', reason: 'carrier_missing', sourceCategory: 'a2a' };
    }
    return buildA2ADispatchTurnCustodyWake({
      threadId: wake.subjectKey.slice(threadSubjectPrefix.length),
      targetCatId,
      messageId: wake.handoff.messageId,
      fromCatId: wake.handoff.fromCatId,
    });
  }
  if (wake.kind === 'action_successor' || wake.kind === 'structured') {
    return { ...wake, holderCatId: targetCatId };
  }
  return wake;
}

async function resolveScheduledWake(
  entry: WakeQueueEntry,
  messageStore: IMessageStore,
): Promise<TurnCustodyWakeProvenance> {
  try {
    const messageId = entry.payload.messageId;
    const sourceMessage = messageId ? await messageStore.getById(messageId) : null;
    if (isManagedHoldConnectorSource(sourceMessage?.source) && sourceMessage?.source?.meta?.phase === 'wake') {
      const meta = sourceMessage.source.meta;
      const taskId = typeof meta?.taskId === 'string' ? meta.taskId : undefined;
      const sourceThreadId = typeof meta?.threadId === 'string' ? meta.threadId : undefined;
      const sourceCatId = typeof meta?.catId === 'string' ? meta.catId : undefined;
      if (!messageId || !taskId || sourceThreadId !== entry.threadId || sourceCatId !== exactTargetCatId(entry)) {
        return { kind: 'legacy', reason: 'carrier_missing', sourceCategory: 'scheduled' };
      }
      return {
        kind: 'structured',
        protocol: 'hold',
        subjectKey: `ball:thread:${entry.threadId}`,
        holderCatId: exactTargetCatId(entry) ?? 'unknown',
        sourceMessageId: messageId,
        taskId,
      };
    }
    return { kind: 'unstructured', source: 'cron' };
  } catch {
    return { kind: 'legacy', reason: 'query_failed', sourceCategory: 'scheduled' };
  }
}

async function resolveA2AWake(entry: WakeQueueEntry, messageStore: IMessageStore): Promise<TurnCustodyWakeProvenance> {
  const messageId = entry.execution.a2aTriggerMessageId ?? entry.payload.messageId;
  const fromCatId = queueEntryCallerCatId(entry);
  if (messageId) {
    try {
      const replyHint = await hydrateCrossThreadReplyHint(messageStore, messageId);
      const noObligationWake = buildCrossThreadNoObligationWake(replyHint);
      if (noObligationWake) return noObligationWake;
    } catch {
      // Optional lifecycle classification failed. The exact dispatch carrier
      // below remains fail-closed and must not be weakened by that lookup.
    }
  }
  return buildA2ADispatchTurnCustodyWake({
    threadId: entry.threadId,
    targetCatId: exactTargetCatId(entry),
    messageId,
    fromCatId,
  });
}

function missingQueueCarrier(entry: WakeQueueEntry): TurnCustodyWakeProvenance {
  return {
    kind: 'legacy',
    reason: 'carrier_missing',
    ...(entry.sourceCategory ? { sourceCategory: entry.sourceCategory } : {}),
  };
}

async function resolveWaitContinuationWake(
  entry: WakeQueueEntry,
  messageStore: IMessageStore,
): Promise<TurnCustodyWakeProvenance | null> {
  const queueCarrier = entry.execution.waitContinuationCarrier;
  if (!queueCarrier) return null;
  const messageId = entry.payload.messageId;
  if (!messageId || entry.execution.actionSuccessorFence) {
    return missingQueueCarrier(entry);
  }

  let storedCarrier: WaitContinuationCarrierV1 | undefined;
  try {
    storedCarrier = waitContinuationCarrierFromStoredMessage(await messageStore.getById(messageId));
  } catch {
    return missingQueueCarrier(entry);
  }
  if (!waitContinuationCarriersMatch(queueCarrier, storedCarrier)) return missingQueueCarrier(entry);

  return {
    kind: 'structured',
    protocol: 'event_wait',
    subjectKey: `ball:thread:${entry.threadId}`,
    holderCatId: exactTargetCatId(entry) ?? 'unknown',
    waitContinuationCarrier: queueCarrier,
  };
}

/** Selects one turn-scoped truth source; absence stays legacy fail-closed. */
export async function resolveQueueTurnCustodyWake(
  entry: WakeQueueEntry,
  messageStore: IMessageStore,
): Promise<TurnCustodyWakeProvenance> {
  const waitWake = await resolveWaitContinuationWake(entry, messageStore);
  if (waitWake) return waitWake;
  if (entry.execution.actionSuccessorFence) {
    return {
      kind: 'action_successor',
      leaseId: entry.execution.actionSuccessorFence.leaseId,
      generation: entry.execution.actionSuccessorFence.generation,
      holderCatId: exactTargetCatId(entry) ?? 'unknown',
    };
  }
  if (entry.from.kind === 'user') return { kind: 'unstructured', source: 'user_chat' };
  if (entry.sourceCategory === 'scheduled') return resolveScheduledWake(entry, messageStore);
  if (entry.sourceCategory === 'freshness') return { kind: 'unstructured', source: 'protocol_decline' };
  if (entry.sourceCategory === 'a2a') return resolveA2AWake(entry, messageStore);
  return {
    kind: 'legacy',
    reason: entry.payload.messageId ? 'carrier_missing' : 'source_missing',
    ...(entry.sourceCategory ? { sourceCategory: entry.sourceCategory } : {}),
  };
}

export function turnCustodyWakeSourceCategory(wake: TurnCustodyWakeProvenance): string {
  if (wake.kind === 'legacy') return wake.sourceCategory ?? 'unknown';
  if (wake.kind === 'action_successor') return 'action_successor';
  if (wake.kind === 'non_obligation') return 'a2a';
  if (wake.kind === 'structured') {
    if (wake.protocol === 'hold') return 'scheduled';
    if (
      wake.protocol === 'dispatch' ||
      wake.protocol === 'assign_work' ||
      wake.protocol === 'coordination' ||
      wake.protocol === 'callback'
    ) {
      return 'a2a';
    }
    return 'unknown';
  }
  if (wake.source === 'user_chat') return 'user';
  if (wake.source === 'cron') return 'scheduled';
  if (wake.source === 'protocol_decline') return 'freshness';
  return 'unknown';
}
