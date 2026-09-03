import type { CatId, RichCardBlock, RuntimeInteractionCardRef, RuntimeInteractionRequest } from '@cat-cafe/shared';
import type { SocketManager } from '../../infrastructure/websocket/index.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { RuntimeInteractionCardPublisher } from './RuntimeInteractionService.js';

type CardMessageStore = Pick<IMessageStore, 'append' | 'getById' | 'getByIdempotencyKey'>;
type CardSocketManager = Pick<SocketManager, 'broadcastToRoom'>;

export interface MessageRuntimeInteractionCardPublisherDeps {
  messageStore: CardMessageStore;
  socketManager: CardSocketManager;
}

export class MessageRuntimeInteractionCardPublisher implements RuntimeInteractionCardPublisher {
  constructor(private readonly deps: MessageRuntimeInteractionCardPublisherDeps) {}

  async publish(request: RuntimeInteractionRequest): Promise<RuntimeInteractionCardRef> {
    const block = buildRuntimeInteractionCard(request);
    const idempotencyKey = `runtime-interaction:${request.interactionId}`;
    let stored = await this.deps.messageStore.getByIdempotencyKey(
      request.owner.userId,
      request.owner.threadId,
      idempotencyKey,
    );
    if (!stored) {
      try {
        stored = await this.deps.messageStore.append({
          userId: request.owner.userId,
          catId: request.owner.catId as CatId,
          content: cardContent(request),
          mentions: [],
          timestamp: request.createdAt,
          threadId: request.owner.threadId,
          idempotencyKey,
          extra: { rich: { v: 1, blocks: [block] } },
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
    assertLiveCanonicalCard(stored, request, block.id);
    this.broadcast(request, stored);
    return { threadId: request.owner.threadId, messageId: stored.id, blockId: block.id };
  }

  async isLive(request: RuntimeInteractionRequest, cardRef: RuntimeInteractionCardRef): Promise<boolean> {
    const stored = await this.deps.messageStore.getById(cardRef.messageId);
    return isLiveCanonicalCard(stored, request, cardRef.blockId);
  }

  private broadcast(request: RuntimeInteractionRequest, stored: StoredMessage): void {
    this.deps.socketManager.broadcastToRoom(
      [`thread:${request.owner.threadId}`, `user:${request.owner.userId}`],
      'connector_message',
      {
        threadId: request.owner.threadId,
        message: {
          id: stored.id,
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

function cardContent(request: RuntimeInteractionRequest): string {
  if (request.kind === 'approval') return `需要你确认：${request.title}`;
  if (request.kind === 'question') return `需要你回答：${request.title}`;
  return `需要你补充：${request.title}`;
}

function assertLiveCanonicalCard(stored: StoredMessage, request: RuntimeInteractionRequest, blockId: string): void {
  if (!isLiveCanonicalCard(stored, request, blockId)) {
    throw new Error('runtime interaction card is deleted or does not match canonical owner/thread/block');
  }
}

function isLiveCanonicalCard(
  stored: StoredMessage | null,
  request: RuntimeInteractionRequest,
  blockId: string,
): stored is StoredMessage {
  return Boolean(
    stored &&
      !stored.deletedAt &&
      !stored._tombstone &&
      stored.userId === request.owner.userId &&
      stored.threadId === request.owner.threadId &&
      stored.extra?.rich?.blocks.some((block) => block.id === blockId),
  );
}
