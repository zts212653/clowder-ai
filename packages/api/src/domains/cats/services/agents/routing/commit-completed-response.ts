import type { CatId } from '@cat-cafe/shared';
import {
  type AppendMessageInput,
  commitLifecycleResponseFromAppendInput,
  type StoredMessage,
} from '../../stores/ports/MessageStore.js';
import type { RouteOptions, RouteStrategyDeps } from './route-helpers.js';

type CompletedWake = Parameters<NonNullable<RouteOptions['commitCompletedA2AWake']>>[0];

/** Both routing modes publish the canonical response and its exact recipient wake here. */
export async function commitCompletedRouteResponse(
  deps: Pick<RouteStrategyDeps, 'messageStore'>,
  input: CompletedWake & {
    admitWake: RouteOptions['commitCompletedA2AWake'];
  },
): Promise<StoredMessage> {
  const { message, targetCats, admitWake, ...identity } = input;
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
  return write(message, [...targetCats]);
}
