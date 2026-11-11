import {
  hasExactLifecycleProcessingDispatch,
  isTargetResponseTerminal,
  type LifecycleActiveRun,
  type LifecycleDispatchRef,
  type LifecycleStoredMessageMetadata,
} from '@cat-cafe/shared';
import type { ChatMessage } from '@/stores/chat-types';

export interface MessageDispatchAvatarProjection {
  targetId: string;
  phase: 'delivered' | 'processing' | 'settled';
  dispatchedAt?: number;
  statusMessageId?: string;
  evidenceKey: string;
}

const TERMINAL_RESPONSE_STATUSES = new Set(['completed', 'failed', 'canceled', 'interrupted']);

function exactMessageById(messages: readonly ChatMessage[], messageId: string): ChatMessage | undefined {
  const matches = messages.filter((candidate) => candidate.id === messageId);
  return matches.length === 1 ? matches[0] : undefined;
}

function deliveredProjection(ref: LifecycleDispatchRef): MessageDispatchAvatarProjection {
  return {
    targetId: ref.targetId,
    phase: 'delivered',
    dispatchedAt: ref.dispatchedAt,
    evidenceKey: `dispatch:${ref.targetId}:${ref.statusMessageId}:${ref.dispatchedAt}`,
  };
}

function linkedProjection(
  ref: LifecycleDispatchRef,
  phase: 'delivered' | 'processing' | 'settled',
  linkedAt: number,
): MessageDispatchAvatarProjection {
  return {
    targetId: ref.targetId,
    phase,
    dispatchedAt: ref.dispatchedAt ?? linkedAt,
    statusMessageId: ref.statusMessageId,
    evidenceKey: `message:${ref.statusMessageId}`,
  };
}

function projectDispatchRef(
  sourceMessageId: string,
  sourceDispatchRefs: readonly LifecycleDispatchRef[],
  ref: LifecycleDispatchRef,
  statusLifecycle: LifecycleStoredMessageMetadata,
  activeRuns: readonly LifecycleActiveRun[],
): MessageDispatchAvatarProjection | null {
  if (statusLifecycle.kind === 'delivery_failure') {
    const exactFailure =
      ref.phase === 'settled' &&
      statusLifecycle.inputMessageId === sourceMessageId &&
      statusLifecycle.requestedTargets.includes(ref.targetId);
    return exactFailure ? linkedProjection(ref, 'settled', statusLifecycle.createdAt) : null;
  }
  if (
    statusLifecycle.kind !== 'response' ||
    statusLifecycle.targetId !== ref.targetId ||
    !statusLifecycle.inputMessageIds.includes(sourceMessageId)
  ) {
    return null;
  }
  if (ref.phase === 'settled') {
    return TERMINAL_RESPONSE_STATUSES.has(statusLifecycle.status)
      ? linkedProjection(ref, 'settled', statusLifecycle.startedAt)
      : null;
  }
  if (statusLifecycle.status !== 'processing') return null;
  return hasExactLifecycleProcessingDispatch({
    sourceMessageId,
    sourceDispatchRefs,
    responseMessageId: ref.statusMessageId,
    responseLifecycle: statusLifecycle,
    activeRuns,
  })
    ? linkedProjection(ref, 'processing', statusLifecycle.startedAt)
    : null;
}

/** The Host alone writes this system carrier; its exact source/ref is the receipt. */
export function pluginDeliveryReceipt(message: ChatMessage | undefined) {
  if (message?.from?.kind !== 'system' || message.from.service !== 'plugin_delivery') return undefined;
  const receipt = message.extra?.pluginAddressedReceipt as
    | { targetId?: unknown; inputMessageId?: unknown; accepted?: unknown; phase?: unknown }
    | undefined;
  return receipt &&
    typeof receipt.targetId === 'string' &&
    typeof receipt.inputMessageId === 'string' &&
    typeof receipt.accepted === 'boolean'
    ? (receipt as {
        targetId: string;
        inputMessageId: string;
        accepted: boolean;
        phase?: 'sending' | 'accepted' | 'unconfirmed';
      })
    : undefined;
}

/**
 * The only live dispatch projection. It consumes exact source/ref/response/run
 * identities and fails closed whenever those records disagree or are ambiguous.
 */
export function projectMessageDispatchAvatars(
  message: ChatMessage,
  timelineMessages: readonly ChatMessage[],
  activeRuns: readonly LifecycleActiveRun[],
): MessageDispatchAvatarProjection[] {
  const refs = message.lifecycle?.dispatchRefs ?? [];
  const targetCounts = new Map<string, number>();
  for (const ref of refs) targetCounts.set(ref.targetId, (targetCounts.get(ref.targetId) ?? 0) + 1);

  return refs.flatMap((ref): MessageDispatchAvatarProjection[] => {
    if (targetCounts.get(ref.targetId) !== 1) return [];
    const statusMessage = exactMessageById(timelineMessages, ref.statusMessageId);
    const receipt = pluginDeliveryReceipt(statusMessage);
    if (receipt?.inputMessageId === message.id && receipt.targetId === ref.targetId)
      return [
        linkedProjection(
          ref,
          statusMessage?.extra?.targetResponse && isTargetResponseTerminal(statusMessage.extra.targetResponse.status)
            ? 'settled'
            : statusMessage?.extra?.targetResponse?.status === 'processing'
              ? 'processing'
              : 'delivered',
          statusMessage!.timestamp,
        ),
      ];
    const statusLifecycle = statusMessage?.lifecycle;
    if (!statusLifecycle) return [deliveredProjection(ref)];
    const linked = projectDispatchRef(message.id, refs, ref, statusLifecycle, activeRuns);
    return [linked ?? deliveredProjection(ref)];
  });
}

/** A delivery-failure row linked from a source is an internal settlement carrier. */
export function isLinkedDeliveryFailureCarrier(
  message: ChatMessage,
  timelineMessages: readonly ChatMessage[],
): boolean {
  const receipt = pluginDeliveryReceipt(message);
  if (receipt)
    return (
      exactMessageById(timelineMessages, receipt.inputMessageId)?.lifecycle?.dispatchRefs?.some(
        (ref) => ref.targetId === receipt.targetId && ref.statusMessageId === message.id,
      ) ?? false
    );
  const lifecycle = message.lifecycle;
  if (lifecycle?.kind !== 'delivery_failure') return false;
  // A targetless origin failure has no source/member settlement to absorb it.
  // It is the canonical user-visible "唤起处理成员失败" system row.
  if (lifecycle.requestedTargets.length === 0) return false;
  const source = exactMessageById(timelineMessages, lifecycle.inputMessageId);
  if (!source) return false;
  // Only a canonical cat source can receive the ordinary A2A failure report.
  // User/connector/system origins must keep this result as their visible row,
  // even though their source avatar also settles against the same result.
  if (source.from?.kind !== 'agent') return false;
  return lifecycle.requestedTargets.every(
    (targetId) =>
      source.lifecycle?.dispatchRefs?.filter(
        (ref) => ref.targetId === targetId && ref.phase === 'settled' && ref.statusMessageId === message.id,
      ).length === 1,
  );
}

export function resolveUnloadedDispatchReply(input: {
  message: ChatMessage;
  targetId: string;
  ref: LifecycleDispatchRef | undefined;
  linkedMessage: ChatMessage | undefined;
  timelineMessages: readonly ChatMessage[];
  activeRuns: readonly LifecycleActiveRun[];
  disqualified: boolean;
}) {
  const { message, targetId, ref, linkedMessage, timelineMessages, activeRuns, disqualified } = input;
  const selfIndex = timelineMessages.findIndex((candidate) => candidate.id === message.id);
  const statusId = ref?.statusMessageId;
  const matchingRuns =
    !linkedMessage && !disqualified && ref?.phase === 'dispatched' && statusId
      ? activeRuns.filter(
          (run) =>
            run.targetId === targetId && run.responseMessageId === statusId && run.inputMessageIds.includes(message.id),
        )
      : [];
  const exactActiveRun = matchingRuns.length === 1 ? matchingRuns[0] : undefined;
  const unloadedSettledAppended =
    !linkedMessage &&
    !disqualified &&
    ref?.phase === 'settled' &&
    Boolean(statusId) &&
    (Boolean(ref.appendDelivery || ref.appendAcceptance) || selfIndex >= 0);
  return {
    selfIndex,
    exactActiveRun,
    unloadedSettledAppended,
    unloadedLinkedReply: exactActiveRun !== undefined || unloadedSettledAppended,
  };
}

export function resolveDispatchReplyArrow(input: {
  message: ChatMessage;
  replyMessageId: string | undefined;
  linkedMessage: ChatMessage | undefined;
  timelineMessages: readonly ChatMessage[];
  selfIndex: number;
  appended: boolean;
  unloadedLinkedReply: boolean;
}): '↑' | '↓' {
  const { message, replyMessageId, linkedMessage, timelineMessages, selfIndex, appended, unloadedLinkedReply } = input;
  const replyIndex = replyMessageId ? timelineMessages.findIndex((candidate) => candidate.id === replyMessageId) : -1;
  return (
    selfIndex >= 0 && replyIndex >= 0
      ? replyIndex < selfIndex
      : unloadedLinkedReply || appended || (linkedMessage !== undefined && linkedMessage.timestamp < message.timestamp)
  )
    ? '↑'
    : '↓';
}
