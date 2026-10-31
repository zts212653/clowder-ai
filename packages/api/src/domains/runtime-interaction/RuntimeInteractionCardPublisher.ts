import type {
  CatId,
  RichBlock,
  RichCardBlock,
  RuntimeInteractionCardRef,
  RuntimeInteractionRequest,
} from '@cat-cafe/shared';
import type { SocketManager } from '../../infrastructure/websocket/index.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { RuntimeInteractionCardPublisher } from './ports/RuntimeInteractionCardPublisher.js';
import { runtimeInteractionBlockDigest } from './RuntimeInteractionPresentationDigest.js';

export { runtimeInteractionBlockDigest } from './RuntimeInteractionPresentationDigest.js';

type CardMessageStore = Pick<IMessageStore, 'append' | 'getById' | 'getByIdempotencyKey'>;
type CardSocketManager = Pick<SocketManager, 'broadcastToRoom'>;

export interface MessageRuntimeInteractionCardPublisherDeps {
  messageStore: CardMessageStore;
  socketManager: CardSocketManager;
}

export class MessageRuntimeInteractionCardPublisher implements RuntimeInteractionCardPublisher {
  constructor(private readonly deps: MessageRuntimeInteractionCardPublisherDeps) {}

  async prepare(request: RuntimeInteractionRequest): Promise<RuntimeInteractionCardRef> {
    const block = buildRuntimeInteractionPresentation(request);
    const idempotencyKey = `runtime-interaction:${request.interactionId}`;
    let stored = await this.deps.messageStore.getByIdempotencyKey(
      request.owner.userId,
      request.owner.threadId,
      idempotencyKey,
    );
    if (!stored) {
      try {
        stored = await this.deps.messageStore.append({
          from: { kind: 'agent', catId: request.owner.catId as CatId },
          userId: request.owner.userId,
          content: cardContent(request),
          mentions: [],
          timestamp: request.createdAt,
          threadId: request.owner.threadId,
          idempotencyKey,
          extra: {
            rich: { v: 1, blocks: [block] },
            runtimeInteractionCard: {
              version: 1,
              interactionId: request.interactionId,
              blockId: block.id,
              requestKind: request.kind,
            },
          },
        });
      } catch (error) {
        stored = await this.deps.messageStore.getByIdempotencyKey(
          request.owner.userId,
          request.owner.threadId,
          idempotencyKey,
        );
        if (!stored) throw error;
      }
    }
    const blockDigest = runtimeInteractionBlockDigest(block);
    const cardRef = {
      threadId: request.owner.threadId,
      messageId: stored.id,
      blockId: block.id,
      blockDigest,
      publishedAt: stored.timestamp,
    };
    assertLiveCanonicalCard(stored, request, cardRef);
    return cardRef;
  }

  async publish(request: RuntimeInteractionRequest, cardRef: RuntimeInteractionCardRef): Promise<void> {
    if (cardRef.threadId !== request.owner.threadId) {
      throw new Error('runtime interaction card does not match canonical thread');
    }
    const stored = await this.deps.messageStore.getById(cardRef.messageId);
    if (!stored) throw new Error('runtime interaction card is unavailable');
    assertLiveCanonicalCard(stored, request, cardRef);
    this.broadcast(request, stored);
  }

  async isLive(request: RuntimeInteractionRequest, cardRef: RuntimeInteractionCardRef): Promise<boolean> {
    const stored = await this.deps.messageStore.getById(cardRef.messageId);
    return isLiveCanonicalCard(stored, request, cardRef);
  }

  private broadcast(request: RuntimeInteractionRequest, stored: StoredMessage): void {
    this.deps.socketManager.broadcastToRoom(
      [`thread:${request.owner.threadId}`, `user:${request.owner.userId}`],
      'connector_message',
      {
        threadId: request.owner.threadId,
        message: {
          id: stored.id,
          from: stored.from,
          type: 'cat',
          catId: request.owner.catId,
          content: stored.content,
          timestamp: stored.timestamp,
          extra: stored.extra,
        },
      },
    );
  }
}

export function buildRuntimeInteractionCard(request: RuntimeInteractionRequest): RichCardBlock {
  if (request.kind === 'conversation_decision') {
    throw new Error('conversation decisions use their original interactive presentation');
  }
  const fields = [
    { label: '来源', value: request.provider.providerId },
    ...(request.provider.itemId ? [{ label: 'Item', value: request.provider.itemId }] : []),
  ];
  return {
    id: `runtime-interaction:${request.interactionId}`,
    kind: 'card',
    v: 1,
    title: request.title,
    ...(request.description ? { bodyMarkdown: request.description } : {}),
    tone: request.kind === 'approval' ? 'warning' : 'info',
    fields,
    meta: {
      kind: 'runtime_interaction',
      interactionId: request.interactionId,
      interactionKind: request.kind,
    },
  };
}

export function buildRuntimeInteractionPresentation(request: RuntimeInteractionRequest): RichBlock {
  return request.kind === 'conversation_decision'
    ? structuredClone(request.presentation)
    : buildRuntimeInteractionCard(request);
}

function cardContent(request: RuntimeInteractionRequest): string {
  if (request.kind === 'conversation_decision') return `需要你决定：${request.title}`;
  if (request.kind === 'approval') return `需要你确认：${request.title}`;
  if (request.kind === 'question') return `需要你回答：${request.title}`;
  return `需要你补充：${request.title}`;
}

/** Return the exact stored presentation only after the canonical card binding remains live. */
export function readVerifiedRuntimeInteractionPresentation(
  stored: StoredMessage | null,
  request: RuntimeInteractionRequest,
  cardRef: RuntimeInteractionCardRef,
): RichBlock | null {
  if (!isLiveCanonicalCard(stored, request, cardRef)) return null;
  const block = stored.extra?.rich?.blocks.find((candidate) => candidate.id === cardRef.blockId);
  return block ? structuredClone(block) : null;
}

function assertLiveCanonicalCard(
  stored: StoredMessage,
  request: RuntimeInteractionRequest,
  cardRef: RuntimeInteractionCardRef,
): void {
  if (!isLiveCanonicalCard(stored, request, cardRef)) {
    throw new Error('runtime interaction card is deleted or does not match canonical owner/thread/block');
  }
}

function isLiveCanonicalCard(
  stored: StoredMessage | null,
  request: RuntimeInteractionRequest,
  cardRef: RuntimeInteractionCardRef,
): stored is StoredMessage {
  const expectedBlock = buildRuntimeInteractionPresentation(request);
  const blocks = stored?.extra?.rich?.blocks ?? [];
  const matchingBlocks = blocks.filter((block) => block.id === cardRef.blockId);
  const liveBlock = matchingBlocks[0];
  const expectedDigest = runtimeInteractionBlockDigest(expectedBlock);
  const binding = stored?.extra?.runtimeInteractionCard;
  const bindingMatches =
    binding?.version === 1 &&
    binding.interactionId === request.interactionId &&
    binding.blockId === cardRef.blockId &&
    binding.requestKind === request.kind;
  const exactConversationBinding =
    cardRef.publishedAt === stored?.timestamp && cardRef.blockDigest === expectedDigest && bindingMatches;
  const compatibleProviderBinding =
    (cardRef.publishedAt === undefined || stored?.timestamp === cardRef.publishedAt) &&
    (cardRef.blockDigest === undefined || cardRef.blockDigest === expectedDigest) &&
    (!binding || bindingMatches);
  const exactBinding = request.kind === 'conversation_decision' ? exactConversationBinding : compatibleProviderBinding;
  return Boolean(
    stored &&
      !stored.deletedAt &&
      !stored._tombstone &&
      stored.userId === request.owner.userId &&
      stored.threadId === request.owner.threadId &&
      stored.from?.kind === 'agent' &&
      stored.from.catId === request.owner.catId &&
      blocks.length === 1 &&
      matchingBlocks.length === 1 &&
      liveBlock &&
      runtimeInteractionBlockDigest(liveBlock) === expectedDigest &&
      exactBinding,
  );
}
