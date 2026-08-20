import type { WaitContinuationCarrierV1 } from '@cat-cafe/shared';
import type { QueueEntry } from '../cats/services/agents/invocation/InvocationQueue.js';
import { hydrateCrossThreadReplyHint, type IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import { handedEventSourceId } from './ball-custody-events.js';
import type { TurnCustodyWakeProvenance } from './TurnCustodyProjectionService.js';
import {
  waitContinuationCarrierFromStoredMessage,
  waitContinuationCarriersMatch,
} from './wait-continuation-carrier.js';

type WakeQueueEntry = Pick<
  QueueEntry,
  | 'actionSuccessorFence'
  | 'a2aTriggerMessageId'
  | 'callerCatId'
  | 'messageId'
  | 'source'
  | 'sourceCategory'
  | 'targetCats'
  | 'threadId'
  | 'waitContinuationCarrier'
>;

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
    const sourceMessage = entry.messageId ? await messageStore.getById(entry.messageId) : null;
    if (sourceMessage?.source?.connector === 'hold-ball') {
      const meta = sourceMessage.source.meta;
      const taskId = typeof meta?.taskId === 'string' ? meta.taskId : undefined;
      const sourceThreadId = typeof meta?.threadId === 'string' ? meta.threadId : undefined;
      const sourceCatId = typeof meta?.catId === 'string' ? meta.catId : undefined;
      if (
        !entry.messageId ||
        !taskId ||
        meta?.wakeWhen !== true ||
        sourceThreadId !== entry.threadId ||
        sourceCatId !== entry.targetCats[0]
      ) {
        return { kind: 'legacy', reason: 'carrier_missing', sourceCategory: 'scheduled' };
      }
      return {
        kind: 'structured',
        protocol: 'hold',
        subjectKey: `ball:thread:${entry.threadId}`,
        holderCatId: entry.targetCats[0] ?? 'unknown',
        sourceMessageId: entry.messageId,
        taskId,
      };
    }
    return { kind: 'unstructured', source: 'cron' };
  } catch {
    return { kind: 'legacy', reason: 'query_failed', sourceCategory: 'scheduled' };
  }
}

async function resolveA2AWake(entry: WakeQueueEntry, messageStore: IMessageStore): Promise<TurnCustodyWakeProvenance> {
  const messageId = entry.a2aTriggerMessageId ?? entry.messageId;
  let fromCatId = entry.callerCatId;
  if (messageId) {
    try {
      const replyHint = await hydrateCrossThreadReplyHint(messageStore, messageId);
      const noObligationWake = buildCrossThreadNoObligationWake(replyHint);
      if (noObligationWake) return noObligationWake;
      fromCatId ??= replyHint?.senderCatId;
    } catch {
      // Optional lifecycle classification failed. The exact dispatch carrier
      // below remains fail-closed and must not be weakened by that lookup.
    }
  }
  if (!fromCatId && messageId) {
    try {
      fromCatId = (await messageStore.getById(messageId))?.catId ?? undefined;
    } catch {
      return { kind: 'legacy', reason: 'query_failed', sourceCategory: 'a2a' };
    }
  }
  return buildA2ADispatchTurnCustodyWake({
    threadId: entry.threadId,
    targetCatId: entry.targetCats[0],
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
  const queueCarrier = entry.waitContinuationCarrier;
  if (!queueCarrier) return null;
  if (entry.source !== 'connector' || !entry.messageId || entry.actionSuccessorFence) {
    return missingQueueCarrier(entry);
  }

  let storedCarrier: WaitContinuationCarrierV1 | undefined;
  try {
    storedCarrier = waitContinuationCarrierFromStoredMessage(await messageStore.getById(entry.messageId));
  } catch {
    return missingQueueCarrier(entry);
  }
  if (!waitContinuationCarriersMatch(queueCarrier, storedCarrier)) return missingQueueCarrier(entry);

  return {
    kind: 'structured',
    protocol: 'event_wait',
    subjectKey: `ball:thread:${entry.threadId}`,
    holderCatId: entry.targetCats[0] ?? 'unknown',
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
  if (entry.actionSuccessorFence) {
    return {
      kind: 'action_successor',
      leaseId: entry.actionSuccessorFence.leaseId,
      generation: entry.actionSuccessorFence.generation,
      holderCatId: entry.targetCats[0] ?? 'unknown',
    };
  }
  if (entry.source === 'user') return { kind: 'unstructured', source: 'user_chat' };
  if (entry.sourceCategory === 'scheduled') return resolveScheduledWake(entry, messageStore);
  if (entry.sourceCategory === 'freshness') return { kind: 'unstructured', source: 'protocol_decline' };
  if (entry.sourceCategory === 'a2a') return resolveA2AWake(entry, messageStore);
  return {
    kind: 'legacy',
    reason: entry.messageId ? 'carrier_missing' : 'source_missing',
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
