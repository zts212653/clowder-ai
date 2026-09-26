import type { PluginManifest } from '@clowder-ai/plugin-contract';
import type { IConnectorThreadBindingStore } from '../../../infrastructure/connectors/ConnectorThreadBindingStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { MessagingError } from '../../messaging/contract/host-types.js';
import type { MessagingService } from '../../messaging/messaging-service.js';
import type { SubscriptionDelivery } from '../../messaging/subscription-delivery.js';
import { removesPluginOwnedResources } from '../external-plugin-lifecycle-types.js';

const SUBSCRIBE_KEYS = new Set(['threadId', 'method', 'includeOwnMessages']);

export interface PluginMessagingSubscribeInput {
  readonly threadId: string;
  readonly method: string;
  readonly includeOwnMessages?: boolean;
}

export interface PluginMessagingSubscriptionHost {
  subscribe(input: PluginMessagingSubscribeInput): Promise<void>;
  unsubscribe(input: { readonly threadId: string }): Promise<void>;
}

export interface PluginMessagingSubscriptionSession {
  readonly host: PluginMessagingSubscriptionHost;
  stop(reason: string): Promise<void>;
}

export interface PluginMessagingSubscriptionSessionDeps {
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly ownerUserId: string;
  readonly effectiveGrants: readonly string[];
  readonly threadStore: IThreadStore;
  readonly bindingStore: IConnectorThreadBindingStore;
  readonly messaging: MessagingService;
  readonly delivery: Pick<SubscriptionDelivery, 'register' | 'unregister'>;
  readonly manifest?: PluginManifest;
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.trim() !== value) {
    throw new MessagingError('VALIDATION', `${field} must be 1..${maximum} non-whitespace-trimmed characters`);
  }
  return value;
}

function requireGrant(deps: PluginMessagingSubscriptionSessionDeps): void {
  if (!deps.effectiveGrants.includes('message.event.subscribe')) {
    throw new MessagingError('PERMISSION', `${deps.pluginId} lacks message.event.subscribe`);
  }
}

function subscribeInput(value: PluginMessagingSubscribeInput): PluginMessagingSubscribeInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MessagingError('VALIDATION', 'messaging.subscribe input must be an object');
  }
  const record = value as unknown as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !SUBSCRIBE_KEYS.has(key));
  if (extra.length > 0) {
    throw new MessagingError('VALIDATION', `messaging.subscribe has unsupported fields: ${extra.join(', ')}`);
  }
  if (record.includeOwnMessages !== undefined && typeof record.includeOwnMessages !== 'boolean') {
    throw new MessagingError('VALIDATION', 'includeOwnMessages must be a boolean when present');
  }
  return {
    threadId: boundedString(record.threadId, 'threadId', 500),
    method: boundedString(record.method, 'method', 500),
    ...(record.includeOwnMessages === undefined ? {} : { includeOwnMessages: record.includeOwnMessages as boolean }),
  };
}

export function createUnavailablePluginMessagingSubscriptionHost(): PluginMessagingSubscriptionSession {
  const unavailable = async () => {
    throw new MessagingError('PERMISSION', 'Host messaging subscription services are unavailable');
  };
  return { host: { subscribe: unavailable, unsubscribe: unavailable }, stop: async () => undefined };
}

export function createPluginMessagingSubscriptionSession(
  deps: PluginMessagingSubscriptionSessionDeps,
): PluginMessagingSubscriptionSession {
  const handles = new Map<string, string>();

  async function requireOwnedThread(threadId: string) {
    const thread = await deps.threadStore.get(threadId);
    if (!thread) throw new MessagingError('NOT_FOUND', `thread ${threadId} does not exist`);
    const bindings = await deps.bindingStore.getByThread(threadId);
    const hasPluginBinding = bindings.some(
      (binding) => binding.connectorId === deps.pluginId && binding.userId === deps.ownerUserId,
    );
    if (
      thread.createdBy !== deps.ownerUserId &&
      thread.pluginOwnership?.pluginInstanceId !== deps.pluginInstanceId &&
      !hasPluginBinding
    ) {
      throw new MessagingError('PERMISSION', `${deps.pluginId} cannot subscribe to thread ${threadId}`);
    }
    return thread;
  }

  async function withdraw(threadId: string, handleId: string): Promise<void> {
    deps.delivery.unregister(deps.pluginInstanceId, threadId);
    await deps.messaging.withdrawSubscription({ pluginInstanceId: deps.pluginInstanceId }, handleId);
    handles.delete(threadId);
  }

  return {
    host: {
      async subscribe(raw) {
        requireGrant(deps);
        const input = subscribeInput(raw);
        await requireOwnedThread(input.threadId);
        const { handleId } = await deps.messaging.ensureThreadHandle({
          pluginInstanceId: deps.pluginInstanceId,
          threadId: input.threadId,
          userId: deps.ownerUserId,
          scope: {
            // Subscription identity must not rotate merely because an unrelated send grant
            // changed; the durable cursor is indexed by this deterministic handle.
            canSend: false,
            canSubscribe: true,
          },
        });
        await deps.delivery.register({
          subscriberId: deps.pluginInstanceId,
          threadId: input.threadId,
          handleId,
          method: input.method,
          ...(() => {
            const declared = deps.manifest?.contributions?.find(
              (entry) => entry.type === 'message-subscription' && entry.action.method === input.method,
            );
            return declared?.type === 'message-subscription'
              ? {
                  ...(declared.lifecycleAction ? { lifecycleMethod: declared.lifecycleAction.method } : {}),
                  ...(declared.presentation === 'v1' || declared.presentation === 'v2'
                    ? { presentationVersion: declared.presentation }
                    : {}),
                }
              : {};
          })(),
          ...(input.includeOwnMessages === undefined
            ? {}
            : { filter: { includeOwnMessages: input.includeOwnMessages } }),
        });
        handles.set(input.threadId, handleId);
      },
      async unsubscribe(raw) {
        requireGrant(deps);
        if (
          !raw ||
          typeof raw !== 'object' ||
          Array.isArray(raw) ||
          Object.keys(raw).some((key) => key !== 'threadId')
        ) {
          throw new MessagingError('VALIDATION', 'messaging.unsubscribe input must contain only threadId');
        }
        const threadId = boundedString((raw as { threadId?: unknown }).threadId, 'threadId', 500);
        const handleId = handles.get(threadId);
        if (handleId !== undefined) await withdraw(threadId, handleId);
      },
    },
    async stop(reason) {
      const active = [...handles.entries()];
      for (const [threadId] of active) deps.delivery.unregister(deps.pluginInstanceId, threadId);
      if (removesPluginOwnedResources(reason)) {
        await Promise.all(
          active.map(([, handleId]) =>
            deps.messaging.withdrawSubscription({ pluginInstanceId: deps.pluginInstanceId }, handleId),
          ),
        );
      }
      handles.clear();
    },
  };
}
