'use client';

import {
  hasExactLifecycleProcessingDispatch,
  type LifecycleActiveRun,
  type LifecycleDispatchRef,
  type LifecycleStoredMessageMetadata,
} from '@cat-cafe/shared';
import type { ChatMessage } from '@/stores/chat-types';
import { focusLineageMessage } from '@/utils/focusLineageMessage';
import { CatAvatar } from './CatAvatar';

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
  phase: 'processing' | 'settled',
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

function formatDispatchTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

interface MessageDispatchAvatarsProps {
  message: ChatMessage;
  timelineMessages: readonly ChatMessage[];
  activeRuns: readonly LifecycleActiveRun[];
  getCatLabel: (catId: string) => string;
}

export function MessageDispatchAvatars({
  message,
  timelineMessages,
  activeRuns,
  getCatLabel,
}: MessageDispatchAvatarsProps) {
  const projections = projectMessageDispatchAvatars(message, timelineMessages, activeRuns);
  if (projections.length === 0) return null;
  const alignsRight = message.type === 'user' && !message.catId;
  return (
    <ul
      className={`-mt-3 mb-4 flex gap-1.5 ${alignsRight ? 'justify-end pr-10' : 'justify-start pl-10'}`}
      data-testid="message-dispatch-avatars"
      aria-label="消息处理成员"
    >
      {projections.map((projection) => {
        const label = getCatLabel(projection.targetId);
        const processing = projection.phase === 'processing';
        const title =
          projection.dispatchedAt === undefined
            ? `${label} 已投递`
            : `${label} 已投递 · ${formatDispatchTime(projection.dispatchedAt)}`;
        return (
          <li
            key={`${projection.targetId}:${projection.evidenceKey}`}
            data-dispatch-target={projection.targetId}
            data-dispatch-phase={projection.phase}
            title={title}
          >
            {projection.statusMessageId ? (
              <button
                type="button"
                aria-label={`${title}，跳转到对应回复`}
                className="block rounded-full"
                onClick={() => focusLineageMessage(projection.statusMessageId!)}
              >
                <CatAvatar catId={projection.targetId} size={11} status={processing ? 'streaming' : undefined} />
              </button>
            ) : (
              <CatAvatar catId={projection.targetId} size={11} status={processing ? 'streaming' : undefined} />
            )}
          </li>
        );
      })}
    </ul>
  );
}
