import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { currentPluginCallContext } from '../carrier/plugin-call-context.js';
import { createMemberOwnerDelegation } from '../member-sessions/owner-delegation.js';

export interface PluginOwnerChatDelegation {
  readonly origin: { readonly messageId: string; readonly threadId: string; readonly helperCatId: string };
  assertCurrent(): Promise<void>;
  assertWriteCurrent(): void;
}
export interface PluginOwnerChatHost {
  /** Current native owner's canonical Chat source; never accepts a claimed source in input. */
  capture(): Promise<PluginOwnerChatDelegation>;
}

/** Reuse the existing canonical owner verifier; no second permission or request ledger. */
export function createPluginOwnerChatHost(deps: {
  readonly pluginInstanceId: string;
  readonly packageDigest: string;
  readonly ownerUserId: string;
  readonly messages: Pick<IMessageStore, 'getById'>;
  readonly threads: Pick<IThreadStore, 'get'>;
  readonly assertCurrent: () => Promise<void>;
  readonly assertWriteCurrent: () => void;
}): PluginOwnerChatHost {
  const verify = createMemberOwnerDelegation(deps);
  return Object.freeze({
    async capture() {
      const caller = currentPluginCallContext(deps.pluginInstanceId);
      if (
        !caller?.nativeAction ||
        !caller.assertWriteCurrent ||
        !caller.originTriggerMessageId ||
        caller.source?.kind === 'adopted_hold' ||
        caller.toolExecutionPolicy !== undefined ||
        caller.ownerAuthProvenance !== 'strict' ||
        caller.userId !== deps.ownerUserId
      )
        throw new Error('owner_chat_delegation_required');
      const write = caller.assertWriteCurrent.bind(caller);
      let invalid = false;
      const assertWriteCurrent = () => {
        if (invalid) throw new Error('owner_chat_delegation_expired');
        deps.assertWriteCurrent();
        write();
      };
      const assertCurrent = async () => {
        try {
          assertWriteCurrent();
          await caller.assertCurrent();
          await deps.assertCurrent();
          await verify(caller, deps);
          await caller.assertCurrent();
          assertWriteCurrent();
        } catch (error) {
          invalid = true;
          if (error instanceof Error && error.message === 'member_session_owner_delegation_required')
            throw new Error('owner_chat_delegation_required');
          throw error;
        }
      };
      await assertCurrent();
      return Object.freeze({
        origin: Object.freeze({
          messageId: caller.originTriggerMessageId,
          threadId: caller.threadId,
          helperCatId: caller.catId,
        }),
        assertCurrent,
        assertWriteCurrent,
      });
    },
  });
}
