import { isCloudConversationAppendMessageInput } from '@clowder-ai/plugin-contract';
import type {
  CloudConversationHostRegistry,
  CloudConversationProvider,
} from '../../../../plugin/declared/cloud-conversation-host-registry.js';
import {
  ConversationHostError,
  type HostAppendMessageReceipt,
  type IConversationHostAdapter,
} from '../conversation-host-adapter.js';
import { readAppendMessageResult } from './conversation-host-results.js';

/**
 * F202 W2-3 h3b — appends through whichever enabled package hosts the provider (contract
 * `cloud-conversation-host`, frozen h3). The dispatch and its mapping (d) stay as they are; this
 * adapter only decides which code a failure carries:
 *
 * - no package holds the provider, or the Host refused the call before the package's action ran:
 *   HOST_UNAVAILABLE, and nothing can have been sent (h3 (e));
 * - the action was entered and then failed, or answered outside the contract: AMBIGUOUS_EFFECT,
 *   since it may have been sent;
 * - the package answered `failed`: its errorCode, with idempotentReplay and a diagnostic the
 *   contract accepts;
 * - the message itself does not fit the contract: INVALID_REQUEST before any call, as the F247
 *   adapter does.
 *
 * The owner-facing messages are fixed sentences; a package's own error text is never repeated
 * there, only kept as the cause.
 */
export class PluginConversationHostAdapter implements IConversationHostAdapter {
  constructor(
    private readonly deps: {
      readonly registry: Pick<CloudConversationHostRegistry, 'current'>;
      readonly provider: CloudConversationProvider;
    },
  ) {}

  async append_message(
    conversationId: string,
    text: string,
    idempotencyKey: string,
  ): Promise<HostAppendMessageReceipt> {
    const lease = this.deps.registry.current(this.deps.provider);
    if (!lease) {
      throw new ConversationHostError(
        'HOST_UNAVAILABLE',
        `No enabled plugin hosts ${this.deps.provider} conversations`,
      );
    }
    const input = { conversationId, text, idempotencyKey };
    if (!isCloudConversationAppendMessageInput(input)) {
      throw new ConversationHostError('INVALID_REQUEST', 'The message does not fit the cloud conversation contract');
    }
    const outcome = await lease.attempt(lease.contribution.appendMessage.method, input);
    if (outcome.status === 'failed') {
      throw outcome.effect === 'not_started'
        ? new ConversationHostError('HOST_UNAVAILABLE', `${lease.pluginId} could not be reached`, {
            cause: outcome.error,
          })
        : new ConversationHostError('AMBIGUOUS_EFFECT', `${lease.pluginId} failed after receiving the message`, {
            cause: outcome.error,
          });
    }
    const result = readAppendMessageResult(outcome.value);
    if (!result) {
      throw new ConversationHostError('AMBIGUOUS_EFFECT', `${lease.pluginId} answered outside the contract`);
    }
    if (result.status === 'appended') {
      return {
        hostMessageId: result.providerMessageId,
        ...(result.idempotentReplay === undefined ? {} : { idempotentReplay: result.idempotentReplay }),
      };
    }
    throw new ConversationHostError(result.errorCode, `${lease.pluginId} did not append the message`, {
      ...(result.idempotentReplay === undefined ? {} : { idempotentReplay: result.idempotentReplay }),
      ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
    });
  }
}
