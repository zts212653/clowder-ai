import { type MessageContent, MessageContentsSchema } from '@cat-cafe/shared';
import type { MessageDraft, PluginManifest, SendReceipt } from '@clowder-ai/plugin-contract';
import type { IConnectorThreadBindingStore } from '../../../infrastructure/connectors/ConnectorThreadBindingStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { MessagingError } from '../../messaging/contract/host-types.js';
import { validateDraft } from '../../messaging/contract/validate.js';
import type { MessagingService } from '../../messaging/messaging-service.js';
import { pluginMessageSourceOf } from './plugin-messaging-source.js';
import {
  createUnavailablePluginMessagingSubscriptionHost,
  type PluginMessagingSubscriptionHost,
} from './plugin-messaging-subscription-host.js';

const SEND_KEYS = new Set([
  'threadId',
  'draftAudience',
  'idempotencyKey',
  'sourceEventId',
  'replyTo',
  'payload',
  'wake',
  'sender',
  'contentBlocks',
  'identity',
  'url',
  'meta',
]);
export type PluginMessagingSendInput = Omit<MessageDraft, 'address'> & {
  readonly threadId: string;
  readonly wake?: 'auto' | { readonly catId: string };
  readonly sender?: { readonly id: string; readonly name?: string };
  readonly contentBlocks?: readonly MessageContent[];
  readonly identity?: string;
  readonly url?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
};

export interface PluginMessagingHost extends PluginMessagingSubscriptionHost {
  send(input: PluginMessagingSendInput): Promise<SendReceipt>;
}

export interface PluginMessagingHostDeps {
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly ownerUserId: string;
  readonly effectiveGrants: readonly string[];
  readonly manifest: PluginManifest;
  readonly threadStore: IThreadStore;
  readonly bindingStore: IConnectorThreadBindingStore;
  readonly messaging: MessagingService;
  readonly subscriptions?: PluginMessagingSubscriptionHost;
}

export function createUnavailablePluginMessagingHost(): PluginMessagingHost {
  const subscriptions = createUnavailablePluginMessagingSubscriptionHost().host;
  return {
    ...subscriptions,
    async send() {
      throw new MessagingError('PERMISSION', 'Host messaging services are unavailable');
    },
  };
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.trim() !== value) {
    throw new MessagingError('VALIDATION', `${field} must be 1..${maximum} non-whitespace-trimmed characters`);
  }
  return value;
}

function wakeOf(value: unknown): PluginMessagingSendInput['wake'] {
  if (value === undefined || value === 'auto') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MessagingError('VALIDATION', 'wake must be auto or { catId }');
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).length !== 1 || !Object.hasOwn(candidate, 'catId')) {
    throw new MessagingError('VALIDATION', 'wake must contain only catId');
  }
  return { catId: boundedString(candidate.catId, 'wake.catId', 200) };
}

function recordOf(input: PluginMessagingSendInput): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new MessagingError('VALIDATION', 'messaging.send input must be an object');
  }
  const record = input as unknown as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !SEND_KEYS.has(key));
  if (extra.length > 0)
    throw new MessagingError('VALIDATION', `messaging.send has unsupported fields: ${extra.join(', ')}`);
  return record;
}

export function createPluginMessagingHost(input: PluginMessagingHostDeps): PluginMessagingHost {
  return {
    ...(input.subscriptions ?? createUnavailablePluginMessagingSubscriptionHost().host),
    async send(value) {
      if (!input.effectiveGrants.includes('messaging.send')) {
        throw new MessagingError('PERMISSION', `${input.pluginId} lacks messaging.send`);
      }
      const record = recordOf(value);
      const threadId = boundedString(record.threadId, 'threadId', 500);
      const thread = await input.threadStore.get(threadId);
      if (!thread) throw new MessagingError('NOT_FOUND', `thread ${threadId} does not exist`);
      const bindings = await input.bindingStore.getByThread(threadId);
      const hasPluginBinding = bindings.some(
        (binding) => binding.connectorId === input.pluginId && binding.userId === input.ownerUserId,
      );
      if (
        thread.createdBy !== input.ownerUserId &&
        thread.pluginOwnership?.pluginInstanceId !== input.pluginInstanceId &&
        !hasPluginBinding
      ) {
        throw new MessagingError('PERMISSION', `${input.pluginId} cannot send to thread ${threadId}`);
      }

      const wake = wakeOf(record.wake);
      const rawOrigin = (record.payload as { provenance?: { origin?: { kind?: unknown } } } | undefined)?.provenance
        ?.origin;
      const validated = validateDraft({
        address:
          rawOrigin?.kind === 'external'
            ? { kind: 'connector_binding', handle: 'internal-validation' }
            : { kind: 'thread_handle', handle: 'internal-validation' },
        ...(record.draftAudience === undefined ? {} : { draftAudience: record.draftAudience }),
        idempotencyKey: record.idempotencyKey,
        ...(record.sourceEventId === undefined ? {} : { sourceEventId: record.sourceEventId }),
        ...(record.replyTo === undefined ? {} : { replyTo: record.replyTo }),
        payload: record.payload,
      });
      const origin = validated.payload.provenance.origin;
      if (origin?.kind === 'plugin' && origin.instanceId !== input.pluginInstanceId) {
        throw new MessagingError('PERMISSION', 'declared plugin origin does not match the calling instance');
      }
      if (
        origin?.kind === 'external' &&
        origin.sourceAddress !== undefined &&
        origin.sourceAddress.connectorId !== origin.connectorId
      ) {
        throw new MessagingError('PERMISSION', 'sourceAddress.connectorId does not match the declared connector');
      }
      const contentBlocks = record.contentBlocks;
      if (contentBlocks !== undefined && !Array.isArray(contentBlocks)) {
        throw new MessagingError('VALIDATION', 'contentBlocks must be an array');
      }
      const parsedContentBlocks =
        contentBlocks === undefined ? undefined : MessageContentsSchema.safeParse(contentBlocks);
      if (parsedContentBlocks !== undefined && !parsedContentBlocks.success) {
        throw new MessagingError('VALIDATION', 'contentBlocks failed Host validation');
      }
      const { source, sender } = pluginMessageSourceOf(input.manifest, origin, {
        sender: record.sender,
        identity: record.identity,
        url: record.url,
        meta: record.meta,
      });
      const scope = {
        canSend: true,
        canSubscribe: input.effectiveGrants.includes('message.event.subscribe'),
      };
      let address: MessageDraft['address'];
      if (origin?.kind === 'external') {
        const sourceAddress = origin.sourceAddress;
        if (!sourceAddress) throw new MessagingError('VALIDATION', 'external origin requires sourceAddress');
        const binding = await input.bindingStore.getByExternal(input.pluginId, sourceAddress.chatId);
        if (!binding || binding.userId !== input.ownerUserId || binding.threadId !== threadId) {
          throw new MessagingError(
            'PERMISSION',
            `external chat ${sourceAddress.chatId} is not bound to thread ${threadId}`,
          );
        }
        const handle = await input.messaging.ensureConnectorBindingHandle({
          pluginInstanceId: input.pluginInstanceId,
          threadId,
          userId: input.ownerUserId,
          scope,
          connectorId: origin.connectorId,
          externalChatId: sourceAddress.chatId,
        });
        address = { kind: 'connector_binding', handle: handle.handleId };
      } else {
        const handle = await input.messaging.ensureThreadHandle({
          pluginInstanceId: input.pluginInstanceId,
          threadId,
          userId: input.ownerUserId,
          scope,
        });
        address = { kind: 'thread_handle', handle: handle.handleId };
      }

      const draft = { ...validated, address };
      const receipt = await input.messaging.sendFromHost({ pluginInstanceId: input.pluginInstanceId }, draft, {
        source,
        ...(parsedContentBlocks === undefined
          ? {}
          : { contentBlocks: parsedContentBlocks.data as readonly MessageContent[] }),
        ...(sender === undefined ? {} : { sender }),
        ...(wake === undefined ? {} : { wake }),
      });
      return receipt;
    },
  };
}
