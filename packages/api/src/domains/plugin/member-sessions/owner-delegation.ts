import { messageFrom } from '../../cats/services/stores/message-from.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { isThreadMessageVisibleToViewer } from '../../cats/services/stores/visibility.js';
import type { MemberSessionServices } from './types.js';

/** Reuse canonical sender/visibility truth. Quoted text, adopted waits, plugin
 * ingress and game players never become a new human delegation source. */
export function createMemberOwnerDelegation(deps: {
  readonly messages: Pick<IMessageStore, 'getById'>;
  readonly threads: Pick<IThreadStore, 'get'>;
}): NonNullable<MemberSessionServices['assertOwnerDelegation']> {
  return async (caller, scope) => {
    const origin = caller.originTriggerMessageId;
    if (
      !origin ||
      caller.userId !== scope.ownerUserId ||
      caller.ownerAuthProvenance !== 'strict' ||
      !caller.nativeAction ||
      caller.toolExecutionPolicy !== undefined
    )
      throw new Error('member_session_owner_delegation_required');
    const thread = await deps.threads.get(caller.threadId);
    const message = await deps.messages.getById(origin);
    const from = message && messageFrom(message);
    if (
      !message ||
      message.threadId !== caller.threadId ||
      message.userId !== scope.ownerUserId ||
      from?.kind !== 'user' ||
      from.userId !== scope.ownerUserId ||
      message.deletedAt ||
      message.recall ||
      message._tombstone ||
      message.sourceParseFailure ||
      message.deliveryStatus === 'canceled' ||
      !isThreadMessageVisibleToViewer(message, scope.ownerUserId) ||
      !thread ||
      thread.deletedAt ||
      thread.createdBy !== scope.ownerUserId
    )
      throw new Error('member_session_owner_delegation_required');
  };
}
