import type { CatId } from '@cat-cafe/shared';
import { commitDotCompletedResponse } from '../../cloud-bridge/dot/dot-completed-response-commit.js';
import {
  type AppendMessageInput,
  commitLifecycleResponseFromAppendInput,
  type StoredMessage,
} from '../../stores/ports/MessageStore.js';
import type { RouteOptions, RouteStrategyDeps } from './route-helpers.js';

type CompletedWake = Parameters<NonNullable<RouteOptions['commitCompletedA2AWake']>>[0];

export function isCollectiveBoundResponse(
  scope: RouteOptions['executionScope'],
  source: StoredMessage | null,
): boolean {
  return (
    scope === 'collective-work' || scope === 'collective-participation' || source?.source?.connector === 'collective'
  );
}

/** Both routing modes publish the canonical response and its exact recipient wake here. */
export async function commitCompletedRouteResponse(
  deps: Pick<RouteStrategyDeps, 'messageStore' | 'dotReplyTarget'>,
  input: CompletedWake & {
    allowDotReturn: boolean;
    triggerMessageId?: string;
    admitWake: RouteOptions['commitCompletedA2AWake'];
  },
): Promise<StoredMessage> {
  const { message, targetCats, allowDotReturn, triggerMessageId, admitWake, ...identity } = input;
  const write = async (next: AppendMessageInput, recipients: CatId[], expectedInputs?: readonly string[]) => {
    const terminal = { ...identity.terminal, ...(expectedInputs ? { expectedInputMessageIds: expectedInputs } : {}) };
    if (recipients.length === 0)
      return commitLifecycleResponseFromAppendInput(
        deps.messageStore,
        identity.responseMessageId,
        identity.invocationId,
        terminal,
        next,
      );
    if (!admitWake) throw new Error('completed response A2A wake admission unavailable');
    return admitWake({ ...identity, terminal, message: next, targetCats: recipients });
  };
  return allowDotReturn && deps.dotReplyTarget
    ? commitDotCompletedResponse({
        messages: deps.messageStore,
        responseMessageId: identity.responseMessageId,
        invocationId: identity.invocationId,
        userId: identity.userId,
        threadId: identity.threadId,
        catId: identity.callerCatId,
        triggerMessageId,
        message,
        targetCats,
        replyTarget: deps.dotReplyTarget,
        commit: write,
      })
    : write(message, [...targetCats]);
}
