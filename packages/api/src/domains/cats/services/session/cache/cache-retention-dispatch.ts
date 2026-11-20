import { getLifecycleAppendOutcome } from '@cat-cafe/shared';
import { messageFrom } from '../../stores/message-from.js';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import { isTimelinePublished } from '../../stores/visibility.js';
import { type RetentionCandidate, retentionKey } from './cache-retention-state.js';

export function retentionCandidate(message: StoredMessage, targets: readonly string[]): RetentionCandidate | null {
  const from = messageFrom(message);
  const cross = message.extra?.crossPost;
  const invocationId =
    cross?.sourceInvocationId ?? message.extra?.stream?.turnInvocationId ?? message.lifecycle?.producerInvocationId;
  if (from.kind !== 'agent' || !invocationId || !targets.length) return null;
  const selected = [...new Set(targets.filter((id) => id !== from.catId))];
  if (!selected.length) return null;
  return {
    id: retentionKey(message.userId, message.id, from.catId),
    userId: message.userId,
    catId: from.catId,
    threadId: cross?.sourceThreadId ?? message.threadId,
    messageId: message.id,
    messageThreadId: message.threadId,
    sourceInvocationId: invocationId,
    targets: selected,
    createdAt: message.timestamp,
  };
}

/** Missing or ambiguous evidence is never a paid maintenance opportunity. */
export async function retentionDispatchPending(
  messages: Pick<IMessageStore, 'getById'>,
  pointer: RetentionCandidate,
): Promise<boolean> {
  const source = await messages.getById(pointer.messageId);
  if (
    !source ||
    source.userId !== pointer.userId ||
    source.threadId !== pointer.messageThreadId ||
    source.deletedAt ||
    source._tombstone ||
    !isTimelinePublished(source)
  )
    return false;
  const observed = retentionCandidate(source, pointer.targets);
  if (
    !observed ||
    observed.threadId !== pointer.threadId ||
    observed.catId !== pointer.catId ||
    observed.sourceInvocationId !== pointer.sourceInvocationId
  )
    return false;
  if (source.lifecycle?.kind !== 'input' && source.lifecycle?.kind !== 'response') return false;
  // Admission stores a source reference. Queue/History owns any later target reselection.
  const currentTargets = new Set(source.lifecycle.dispatchRefs?.map((ref) => ref.targetId));
  for (const target of currentTargets) {
    const refs = source.lifecycle.dispatchRefs?.filter((ref) => ref.targetId === target) ?? [];
    const ref = refs.length === 1 ? refs[0] : undefined;
    if (!ref || getLifecycleAppendOutcome(ref, source.lifecycle) !== undefined) continue;
    if (ref.phase === 'dispatched') {
      const response = await messages.getById(ref.statusMessageId);
      if (
        response?.userId === pointer.userId &&
        response.threadId === pointer.messageThreadId &&
        !response.deletedAt &&
        !response._tombstone &&
        response.lifecycle?.kind === 'response' &&
        response.lifecycle.targetId === target &&
        response.lifecycle.inputMessageIds.includes(pointer.messageId) &&
        response.lifecycle.status === 'processing'
      )
        return true;
    }
  }
  return false;
}
