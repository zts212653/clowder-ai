import type { CatId, ConnectorSource, MessageFrom } from '@cat-cafe/shared';
import type { SocketManager } from '../../infrastructure/websocket/index.js';
import { emitQueueUpdated } from '../../utils/queue-enrichment.js';
import type { InvocationQueue } from '../cats/services/agents/invocation/InvocationQueue.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type {
  RuntimeConversationReturnGateway,
  RuntimeConversationReturnMessage,
} from './ports/RuntimeConversationReturnGateway.js';

const RUNTIME_INTERACTION_SOURCE: ConnectorSource = {
  connector: 'runtime-interaction',
  label: '对话决定',
  icon: 'cat-cafe',
};

type ReturnSocketManager = Pick<SocketManager, 'broadcastToRoom' | 'emitToUser'>;
type ConversationReturnInput = Parameters<RuntimeConversationReturnGateway['deliver']>[0];
type ReturnCoordinates = {
  threadId: string;
  userId: string;
  requesterCatId: CatId;
  idempotencyKey: string;
  cardMessageId: string;
};

export class MessageQueueRuntimeConversationReturnGateway implements RuntimeConversationReturnGateway {
  private readonly inFlight = new Map<string, { signature: string; promise: Promise<{ messageId: string }> }>();

  constructor(
    private readonly deps: {
      messageStore: IMessageStore;
      queue: InvocationQueue;
      socketManager: ReturnSocketManager;
      tryAutoExecute: (threadId: string) => Promise<unknown>;
      now?: () => number;
    },
  ) {}

  async deliver(input: ConversationReturnInput): Promise<{ messageId: string }> {
    const request = input.record.request;
    if (request.kind !== 'conversation_decision' || !input.record.cardRef) {
      throw new Error('conversation return requires a canonical decision card');
    }
    const coordinates: ReturnCoordinates = {
      threadId: request.owner.threadId,
      userId: request.owner.userId,
      requesterCatId: request.owner.catId as CatId,
      idempotencyKey: `runtime-interaction:return:${input.interactionId}:${input.operationId}`,
      cardMessageId: input.record.cardRef.messageId,
    };
    const signature = JSON.stringify([
      input.interactionId,
      input.operationId,
      input.author,
      input.content,
      coordinates.threadId,
      coordinates.userId,
      coordinates.requesterCatId,
      coordinates.cardMessageId,
    ]);
    const active = this.inFlight.get(coordinates.idempotencyKey);
    if (active) {
      if (active.signature !== signature) throw new Error('conversation return in-flight identity conflicts');
      return active.promise;
    }
    const promise = this.deliverOnce(input, coordinates);
    this.inFlight.set(coordinates.idempotencyKey, { signature, promise });
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(coordinates.idempotencyKey)?.promise === promise) {
        this.inFlight.delete(coordinates.idempotencyKey);
      }
    }
  }

  private async deliverOnce(
    input: ConversationReturnInput,
    coordinates: ReturnCoordinates,
  ): Promise<{ messageId: string }> {
    const existing = await this.deps.messageStore.getByIdempotencyKey(
      coordinates.userId,
      coordinates.threadId,
      coordinates.idempotencyKey,
    );
    if (existing) this.assertExactReturn(existing, input);
    const from: MessageFrom =
      input.author === 'owner'
        ? { kind: 'user', userId: coordinates.userId }
        : { kind: 'system', service: 'runtime-interaction' };
    const result = await this.deps.queue.send(
      this.deps.messageStore,
      {
        userId: coordinates.userId,
        threadId: coordinates.threadId,
        from,
        content: input.content,
        mentions: [coordinates.requesterCatId],
        timestamp: this.deps.now?.() ?? Date.now(),
        replyTo: coordinates.cardMessageId,
        idempotencyKey: coordinates.idempotencyKey,
        deliveryStatus: 'queued',
        ...(input.author === 'host' ? { origin: 'callback' as const, source: RUNTIME_INTERACTION_SOURCE } : {}),
        extra: {
          targetCats: [coordinates.requesterCatId],
          runtimeInteractionReturn: {
            interactionId: input.interactionId,
            operationId: input.operationId,
            author: input.author,
            requesterCatId: coordinates.requesterCatId,
            cardMessageId: coordinates.cardMessageId,
          },
        },
      },
      {
        threadId: coordinates.threadId,
        userId: coordinates.userId,
        kind: 'message_wake',
        from,
        ownerAuthProvenance: input.author === 'owner' ? 'strict' : 'unknown',
        content: input.content,
        sourceCategory: 'producer_return',
        targetCats: [coordinates.requesterCatId],
        intent: 'execute',
        autoExecute: true,
        priority: 'urgent',
        idempotencyKey: coordinates.idempotencyKey,
      },
    );
    if (result.outcome !== 'enqueued') throw new Error('conversation return queue is full');
    this.assertExactReturn(result.message, input);
    if (input.author === 'host') this.broadcastHostReturn(result.message);
    await this.publishQueue(coordinates.threadId, coordinates.userId);
    return { messageId: result.message.id };
  }

  async readOwnerMessage(messageId: string): Promise<RuntimeConversationReturnMessage | null> {
    const message = await this.deps.messageStore.getById(messageId);
    if (!message?.from) return null;
    return {
      userId: message.userId,
      threadId: message.threadId,
      from: message.from,
      timestamp: message.timestamp,
      ...(message.deletedAt !== undefined ? { deletedAt: message.deletedAt } : {}),
      ...(message._tombstone ? { tombstone: true } : {}),
    };
  }

  private async publishQueue(threadId: string, userId: string): Promise<void> {
    await emitQueueUpdated(
      this.deps.socketManager,
      userId,
      threadId,
      this.deps.queue.list(threadId, userId),
      'runtime_interaction_return',
    );
    await this.deps.tryAutoExecute(threadId);
  }

  private broadcastHostReturn(message: StoredMessage): void {
    this.deps.socketManager.broadcastToRoom(`thread:${message.threadId}`, 'connector_message', {
      threadId: message.threadId,
      message: {
        id: message.id,
        type: 'connector',
        from: message.from,
        content: message.content,
        source: RUNTIME_INTERACTION_SOURCE,
        timestamp: message.timestamp,
      },
    });
  }

  private assertExactReturn(message: StoredMessage, input: ConversationReturnInput): void {
    const request = input.record.request;
    if (request.kind !== 'conversation_decision' || !input.record.cardRef) throw new Error('wrong interaction kind');
    const meta = message.extra?.runtimeInteractionReturn;
    if (
      message.userId !== request.owner.userId ||
      message.threadId !== request.owner.threadId ||
      !message.from ||
      (input.author === 'owner'
        ? message.from.kind !== 'user' || message.from.userId !== request.owner.userId
        : message.from.kind !== 'system' || message.from.service !== 'runtime-interaction') ||
      message.content !== input.content ||
      message.replyTo !== input.record.cardRef.messageId ||
      meta?.interactionId !== input.interactionId ||
      meta.operationId !== input.operationId ||
      meta.author !== input.author ||
      meta.requesterCatId !== request.owner.catId ||
      meta.cardMessageId !== input.record.cardRef.messageId ||
      !message.mentions.includes(request.owner.catId as CatId) ||
      (input.author === 'host' ? message.source?.connector !== 'runtime-interaction' : message.source !== undefined)
    ) {
      throw new Error('conversation return idempotency key conflicts with another message');
    }
  }
}
