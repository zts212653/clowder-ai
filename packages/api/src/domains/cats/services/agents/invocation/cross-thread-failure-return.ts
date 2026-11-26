import { isCrossThreadProvenance } from '@cat-cafe/shared';
import type { StoredMessage } from '../../stores/ports/MessageStore.js';
import type { QueueEnqueueInput } from './InvocationQueue.js';
import type { OwnerAuthProvenance } from './owner-auth-provenance.js';

export function isCrossThreadSource(source: StoredMessage): boolean {
  return isCrossThreadProvenance(source.extra?.crossPost?.sourceThreadId, source.threadId);
}

export function crossThreadFailureReturnSourceId(sourceMessageId: string, failureMessageId: string): string {
  return `cross-thread-failure:${failureMessageId}:${sourceMessageId}`;
}

/** A control return to the admitted sender's thread, never a new business dispatch. */
export function crossThreadFailureReturnInput(
  source: StoredMessage,
  failureMessageId: string,
  failedTargetIds: readonly string[],
  ownerAuthProvenance: OwnerAuthProvenance,
): Omit<QueueEnqueueInput, 'messageId'> & { sourceId: string } {
  const crossPost = source.extra?.crossPost;
  if (!crossPost || crossPost.sourceThreadId === source.threadId || source.from?.kind !== 'agent') {
    throw new Error('cross-thread failure return requires an exact cross-post agent source');
  }
  const sourceId = crossThreadFailureReturnSourceId(source.id, failureMessageId);
  return {
    kind: 'private_input',
    from: { kind: 'system', service: 'message_delivery' },
    threadId: crossPost.sourceThreadId,
    userId: source.userId,
    sourceId,
    sourceCategory: 'a2a_failure',
    targetCats: [source.from.catId],
    ownerAuthProvenance,
    content: [
      '[跨线程派活失败]',
      `你从本线程发给 ${source.threadId} 的 ${failedTargetIds.join('、')} 的派活失败。`,
      `派活消息：${source.threadId}#${source.id}`,
      `失败结果：${source.threadId}#${failureMessageId}`,
      `读取完整原因请用 cat_cafe_get_thread_context(threadId="${source.threadId}", messageId="${failureMessageId}", before=0, after=0, responseMode="full")，在本来源线程接续处理。`,
    ].join('\n'),
    intent: 'execute',
    autoExecute: true,
    a2aTriggerMessageId: sourceId,
    ...(crossPost.sourceInvocationId ? { a2aParentInvocationId: crossPost.sourceInvocationId } : {}),
  };
}
