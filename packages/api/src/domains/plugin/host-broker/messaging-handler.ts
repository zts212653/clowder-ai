import {
  type MessagingRowInputByMethod,
  type MessagingRowResultByMethod,
  validateMessagingRowInput,
  validateMessagingRowResult,
} from '@clowder-ai/plugin-contract';
import type { MessagingService } from '../../messaging/messaging-service.js';
import type { PluginMediaReadService } from '../host-surface/plugin-media-host.js';
import type { BrokerCallContext, BrokerCallError, BrokerMethodHandler, BrokerValidationResult } from './types.js';
import { HostBrokerError } from './types.js';

type MessagingPluginMethod =
  | 'messaging.send'
  | 'messaging.appendElements'
  | 'messaging.subscribe'
  | 'messaging.read'
  | 'messaging.ack'
  | 'messaging.snapshot'
  | 'media.read';

export interface MessagingBrokerHandlerOptions {
  readonly messaging?: Pick<
    MessagingService,
    'send' | 'appendElements' | 'subscribe' | 'read' | 'ack' | 'snapshotPage'
  >;
  readonly media?: Pick<PluginMediaReadService, 'read'>;
}

function directHandler<Method extends MessagingPluginMethod>(
  method: Method,
  dispatch: (
    context: BrokerCallContext,
    input: MessagingRowInputByMethod[Method],
  ) => Promise<MessagingRowResultByMethod[Method]>,
): BrokerMethodHandler<MessagingRowInputByMethod[Method], MessagingRowResultByMethod[Method]> {
  return {
    method,
    settlementAuthority: 'domain',
    validateInput(value: unknown): BrokerValidationResult<MessagingRowInputByMethod[Method]> {
      const result = validateMessagingRowInput(method, value);
      return result.valid ? { valid: true, value: result.value } : { valid: false };
    },
    validateResult(value: unknown): value is MessagingRowResultByMethod[Method] {
      return validateMessagingRowResult(method, value).valid;
    },
    settlementKey: () => method,
    dispatch,
    lookupSettlement: async () => null,
    serializePreEffectError: (): BrokerCallError | null => null,
    restoreSettledError(error: BrokerCallError): Error {
      return new HostBrokerError('BROKER_INVARIANT', `${method} unexpectedly stored ${error.code}`);
    },
  };
}

export function createMessagingBrokerHandlers(options: MessagingBrokerHandlerOptions): readonly BrokerMethodHandler[] {
  const { messaging, media } = options;
  const ctx = (context: BrokerCallContext) => ({ pluginInstanceId: context.pluginInstanceId });
  return [
    ...(messaging === undefined
      ? []
      : [
          directHandler('messaging.send', (context, input) => messaging.send(ctx(context), input)),
          directHandler('messaging.appendElements', (context, input) => messaging.appendElements(ctx(context), input)),
          directHandler('messaging.subscribe', (context, input) => messaging.subscribe(ctx(context), input.handle)),
          directHandler('messaging.read', (context, input) =>
            messaging.read(ctx(context), input.subscriptionId, { limit: input.limit }),
          ),
          directHandler('messaging.ack', async (context, input) => {
            await messaging.ack(ctx(context), input.subscriptionId, input.ackToken);
            return null;
          }),
          directHandler('messaging.snapshot', (context, input) => messaging.snapshotPage(ctx(context), input)),
        ]),
    ...(media === undefined ? [] : [directHandler('media.read', (context, input) => media.read(context, input))]),
  ];
}
