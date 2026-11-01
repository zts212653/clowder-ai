import type { CatId } from '@cat-cafe/shared';
import type { MemberThreadBinding } from '../../../../plugin/member-sessions/types.js';
import type { AgentMessage } from '../../types.js';
import type { RouteOptions } from './route-helpers.js';

export interface ScopedMemberRouteInput {
  readonly userId: string;
  readonly threadId: string;
  readonly sourceMessageId: string;
  readonly targetCats: readonly CatId[];
  readonly options: Pick<
    RouteOptions,
    | 'signal'
    | 'signalForCat'
    | 'stopMember'
    | 'onAgentClientActiveRunReady'
    | 'routeSpan'
    | 'parentInvocationId'
    | 'ownerAuthProvenance'
    | 'onLifecycleInvocationStarted'
    | 'onPromptMessagesExposed'
  >;
}
export type ScopedMemberRouteResult =
  | { readonly kind: 'ordinary' }
  | {
      readonly kind: 'controlled';
      readonly stream: AsyncIterable<AgentMessage>;
    };
export interface ScopedMemberRoutingPort {
  resolve(input: ScopedMemberRouteInput): Promise<ScopedMemberRouteResult>;
}

/** Only a successful absent-marker read can choose ordinary routing. A protected
 * thread with an unavailable controller stays protected, including after restart. */
export function createScopedMemberRouting(deps: {
  readonly binding: (threadId: string) => Promise<MemberThreadBinding | null>;
  readonly invoke?: (input: ScopedMemberRouteInput, binding: MemberThreadBinding) => AsyncIterable<AgentMessage>;
}): ScopedMemberRoutingPort {
  return {
    async resolve(input) {
      const {
        signal,
        signalForCat,
        stopMember,
        onAgentClientActiveRunReady,
        routeSpan,
        parentInvocationId,
        ownerAuthProvenance,
        onLifecycleInvocationStarted,
        onPromptMessagesExposed,
      } = input.options;
      const captured: ScopedMemberRouteInput = {
        userId: input.userId,
        threadId: input.threadId,
        sourceMessageId: input.sourceMessageId,
        targetCats: Object.freeze([...input.targetCats]),
        options: Object.freeze({
          signal,
          signalForCat,
          stopMember,
          onAgentClientActiveRunReady,
          routeSpan,
          parentInvocationId,
          ownerAuthProvenance,
          onLifecycleInvocationStarted,
          onPromptMessagesExposed,
        }),
      };
      const binding = await deps.binding(captured.threadId);
      if (!binding) return { kind: 'ordinary' };
      if (
        binding.threadId !== captured.threadId ||
        binding.ownerUserId !== captured.userId ||
        captured.targetCats.length !== 1 ||
        captured.targetCats[0] !== binding.catId ||
        !captured.sourceMessageId
      )
        throw new Error('controlled_member_route_scope_mismatch');
      if (!deps.invoke) throw new Error('controlled_member_not_ready');
      return { kind: 'controlled', stream: deps.invoke(captured, Object.freeze({ ...binding })) };
    },
  };
}
