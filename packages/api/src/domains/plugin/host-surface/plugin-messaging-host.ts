import { type MessageContent, MessageContentsSchema, type MessageFrom } from '@cat-cafe/shared';
import type { MessageDraft, PluginManifest, SendReceipt } from '@clowder-ai/plugin-contract';
import { messageFrom } from '../../cats/services/stores/message-from.js';
import { storedMessageSource } from '../../cats/services/stores/message-source.js';
import {
  deriveGrowingSourceMessageRevision,
  type IMessageStore,
  type StoredMessage,
} from '../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { isSystemUserMessage, resolveThreadMessageVisibility } from '../../cats/services/stores/visibility.js';
import { MessagingError } from '../../messaging/contract/host-types.js';
import { validateDraft } from '../../messaging/contract/validate.js';
import type { MessagingService } from '../../messaging/messaging-service.js';
import { resolveTargetResponse } from '../../messaging/target-response.js';
import { pluginMessageSourceOf } from './plugin-messaging-source.js';
import {
  createUnavailablePluginMessagingSubscriptionHost,
  type PluginMessagingSubscriptionHost,
} from './plugin-messaging-subscription-host.js';
import {
  createPluginSentMessageReader,
  type PluginSentMessage,
  type PluginSentMessageLookup,
  type PluginSentMessageReadServices,
} from './plugin-sent-message-read.js';

const SEND_KEYS = new Set([
  'threadId',
  'draftAudience',
  'idempotencyKey',
  'sourceEventId',
  'replyTo',
  'response',
  'payload',
  'wake',
  'sender',
  'contentBlocks',
  'identity',
  'meta',
]);
export type PluginMessagingSendInput = Omit<MessageDraft, 'address'> & {
  readonly threadId: string;
  readonly wake?: import('../../messaging/ingress-wake.js').PluginMessageWake;
  readonly sender?: { readonly id: string; readonly name?: string };
  readonly contentBlocks?: readonly MessageContent[];
  readonly identity?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly response?: {
    readonly deliveryId: string;
    readonly status: import('@cat-cafe/shared').TargetResponseResult['status'];
  };
};

/** Public message facts; private execution/custody records are never projected. */
export type PluginMessage = Pick<
  StoredMessage,
  | 'id'
  | 'threadId'
  | 'userId'
  | 'catId'
  | 'content'
  | 'contentBlocks'
  | 'mentions'
  | 'timestamp'
  | 'source'
  | 'origin'
  | 'replyTo'
  | 'deliveryStatus'
> & {
  /** Canonical sender proof, independent of presentation. No connector addresses or private service IDs. */
  readonly from:
    | Extract<MessageFrom, { kind: 'user' | 'agent' }>
    | { readonly kind: Exclude<MessageFrom['kind'], 'user' | 'agent'> };
  readonly sourceRevision: string;
  readonly extra?: {
    readonly rich?: NonNullable<StoredMessage['extra']>['rich'];
    readonly stream?: Pick<
      NonNullable<NonNullable<StoredMessage['extra']>['stream']>,
      'invocationId' | 'turnInvocationId'
    >;
    readonly causal?: NonNullable<StoredMessage['extra']>['causal'];
  };
};

export interface PluginMessagingHost extends PluginMessagingSubscriptionHost {
  get(messageId: string): Promise<PluginMessage | null>;
  findSent(input: PluginSentMessageLookup): Promise<PluginSentMessage | null>;
  send(input: PluginMessagingSendInput): Promise<SendReceipt>;
  /** Additional synchronous rejection fence; never grants identity or bypasses Host checks. */
  sendWithAdmission?(input: PluginMessagingSendInput, assertCurrent: () => void): Promise<SendReceipt>;
}

export interface PluginMessagingHostDeps extends PluginSentMessageReadServices {
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly ownerUserId: string;
  readonly manifest: PluginManifest;
  readonly threadStore: IThreadStore;
  readonly messageStore?: Pick<IMessageStore, 'getById'> & Partial<Pick<IMessageStore, 'getByIdempotencyKey'>>;
  readonly assertCurrent?: () => void;
  /** Host-only execution lease check, consumed after asynchronous send preparation. */
  readonly assertAdmissionCurrent?: () => Promise<void>;
  readonly messaging: MessagingService;
  readonly subscriptions?: PluginMessagingSubscriptionHost;
}

export function createUnavailablePluginMessagingHost(): PluginMessagingHost {
  const subscriptions = createUnavailablePluginMessagingSubscriptionHost().host;
  return {
    ...subscriptions,
    async get() {
      throw new MessagingError('PERMISSION', 'Host message read service is unavailable');
    },
    async findSent() {
      throw new MessagingError('PERMISSION', 'Durable Host delivery lookup is unavailable');
    },
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
  if (
    Object.keys(candidate).some((key) => !['catId', 'exact'].includes(key)) ||
    !Object.hasOwn(candidate, 'catId') ||
    (candidate.exact !== undefined && candidate.exact !== true)
  ) {
    throw new MessagingError('VALIDATION', 'wake must contain catId and optional exact:true');
  }
  return {
    catId: boundedString(candidate.catId, 'wake.catId', 200),
    ...(candidate.exact === true ? { exact: true as const } : {}),
  };
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

// Direct owner reads retain original input while Queue admission changes its
// delivery state. This does not publish it to timelines or model context.
function isReadablePluginMessage(message: StoredMessage, ownerUserId: string): boolean {
  return (
    resolveThreadMessageVisibility(undefined, ownerUserId)(message) ||
    (message.deliveryStatus === 'queued' &&
      message.userId === ownerUserId &&
      message.catId === null &&
      message.origin !== 'briefing' &&
      !isSystemUserMessage(message))
  );
}

export function createPluginMessagingHost(input: PluginMessagingHostDeps): PluginMessagingHost {
  return {
    findSent: createPluginSentMessageReader(input),
    ...(input.subscriptions ?? createUnavailablePluginMessagingSubscriptionHost().host),
    async sendWithAdmission(value, assertCurrent) {
      if (typeof assertCurrent !== 'function')
        throw new MessagingError('VALIDATION', 'send admission requires a synchronous assertion');
      return createPluginMessagingHost({
        ...input,
        async assertAdmissionCurrent() {
          await input.assertAdmissionCurrent?.();
          input.assertCurrent?.();
          const result: unknown = assertCurrent();
          if (result !== undefined) {
            // Drain a mistakenly async callback without treating its result as authority.
            void Promise.resolve(result).catch(() => undefined);
            throw new MessagingError('VALIDATION', 'send admission assertion must return void synchronously');
          }
        },
      }).send(value);
    },
    async get(value) {
      input.assertCurrent?.();

      const id = boundedString(value, 'messageId', 500);
      if (!input.messageStore) throw new MessagingError('NOT_FOUND', 'Host message read service is unavailable');
      const message = structuredClone(await input.messageStore.getById(id));
      input.assertCurrent?.();
      if (
        !message ||
        message.deletedAt ||
        message._tombstone ||
        message.recall ||
        message.sourceParseFailure ||
        !isReadablePluginMessage(message, input.ownerUserId) ||
        (message.userId !== input.ownerUserId && !isSystemUserMessage(message))
      )
        return null;
      const thread = await input.threadStore.get(message.threadId);
      input.assertCurrent?.();
      if (!thread || thread.deletedAt) return null;
      return projectMessage(message);
    },
    async send(value) {
      input.assertCurrent?.();

      const record = recordOf(value);
      const threadId = boundedString(record.threadId, 'threadId', 500);
      const thread = await input.threadStore.get(threadId);
      input.assertCurrent?.();
      if (!thread || thread.deletedAt) throw new MessagingError('NOT_FOUND', `thread ${threadId} does not exist`);
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
      const responseResult =
        record.response === undefined
          ? undefined
          : await resolveTargetResponse(
              input.messageStore as IMessageStore,
              input.pluginInstanceId,
              threadId,
              record.replyTo,
              record.response,
            );
      const { source, sender } = pluginMessageSourceOf(input.manifest, origin, {
        sender: record.sender,
        identity: record.identity,
        meta: record.meta,
      });
      const scope = {
        canSend: true,
        canSubscribe: true,
      };
      let address: MessageDraft['address'];
      if (origin?.kind === 'external') {
        const sourceAddress = origin.sourceAddress;
        if (!sourceAddress) throw new MessagingError('VALIDATION', 'external origin requires sourceAddress');
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

      input.assertCurrent?.();
      const draft = { ...validated, address };
      const receipt = await input.messaging.sendFromHost({ pluginInstanceId: input.pluginInstanceId }, draft, {
        source,
        ...(responseResult ? { responseResult } : {}),
        ...(input.assertAdmissionCurrent ? { assertAdmissionCurrent: input.assertAdmissionCurrent } : {}),
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

function projectMessage(message: StoredMessage): PluginMessage {
  const from = messageFrom(message);
  const stream = message.extra?.stream;
  const extra: NonNullable<PluginMessage['extra']> = {
    ...(message.extra?.rich ? { rich: message.extra.rich } : {}),
    ...(stream
      ? {
          stream: {
            ...(stream.invocationId ? { invocationId: stream.invocationId } : {}),
            ...(stream.turnInvocationId ? { turnInvocationId: stream.turnInvocationId } : {}),
          },
        }
      : {}),
    ...(message.extra?.causal ? { causal: message.extra.causal } : {}),
  };
  return {
    id: message.id,
    threadId: message.threadId,
    userId: message.userId,
    catId: message.catId,
    from:
      from.kind === 'user'
        ? { kind: from.kind, userId: from.userId }
        : from.kind === 'agent'
          ? { kind: from.kind, catId: from.catId }
          : { kind: from.kind },
    content: message.content,
    mentions: message.mentions,
    timestamp: message.timestamp,
    sourceRevision: deriveGrowingSourceMessageRevision(message),
    ...(message.contentBlocks ? { contentBlocks: message.contentBlocks } : {}),
    ...(storedMessageSource(message) ? { source: storedMessageSource(message) } : {}),
    ...(message.origin ? { origin: message.origin } : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    ...(message.deliveryStatus ? { deliveryStatus: message.deliveryStatus } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}
