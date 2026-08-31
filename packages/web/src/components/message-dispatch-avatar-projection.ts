import type { LifecycleActiveRun } from '@cat-cafe/shared';
import type { ChatMessage } from '@/stores/chat-types';

export interface MessageDispatchAvatarProjection {
  targetId: string;
  status: 'streaming' | 'done' | 'error';
  responseMessageId: string;
}

/**
 * Project only states proven by the durable input/response pair. A dynamic
 * working claim additionally requires the exact ActiveRun identity; missing or
 * conflicting evidence deliberately renders nothing.
 */
export function projectMessageDispatchAvatars(
  message: ChatMessage,
  timelineMessages: readonly ChatMessage[],
  activeRuns: readonly LifecycleActiveRun[],
): MessageDispatchAvatarProjection[] {
  const sourceLifecycle = message.lifecycle;
  if (
    !sourceLifecycle ||
    (sourceLifecycle.kind !== 'input' &&
      (sourceLifecycle.kind !== 'response' || sourceLifecycle.status !== 'completed'))
  ) {
    return [];
  }
  const responseById = new Map(timelineMessages.map((candidate) => [candidate.id, candidate]));

  return (sourceLifecycle.dispatchRefs ?? []).flatMap((ref): MessageDispatchAvatarProjection[] => {
    if (ref.phase === 'assigned') return [];
    const response = responseById.get(ref.statusMessageId);
    const lifecycle = response?.lifecycle;
    if (lifecycle?.kind === 'delivery_failure') {
      if (
        ref.phase !== 'settled' ||
        lifecycle.inputMessageId !== message.id ||
        !lifecycle.requestedTargets.includes(ref.targetId)
      ) {
        return [];
      }
      return [{ targetId: ref.targetId, status: 'error', responseMessageId: ref.statusMessageId }];
    }
    if (
      lifecycle?.kind !== 'response' ||
      lifecycle.targetId !== ref.targetId ||
      !lifecycle.inputMessageIds.includes(message.id)
    ) {
      return [];
    }

    if (ref.phase === 'settled') {
      if (lifecycle.status === 'completed') {
        return [{ targetId: ref.targetId, status: 'done', responseMessageId: ref.statusMessageId }];
      }
      if (lifecycle.status !== 'processing') {
        return [{ targetId: ref.targetId, status: 'error', responseMessageId: ref.statusMessageId }];
      }
      return [];
    }

    if (lifecycle.status !== 'processing') return [];
    const exactRun = activeRuns.some(
      (run) =>
        run.targetId === ref.targetId &&
        run.responseMessageId === ref.statusMessageId &&
        run.invocationId === lifecycle.invocationId &&
        run.inputMessageIds.includes(message.id),
    );
    return exactRun ? [{ targetId: ref.targetId, status: 'streaming', responseMessageId: ref.statusMessageId }] : [];
  });
}
