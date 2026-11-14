import type { RedisClient } from '@cat-cafe/shared/utils';
import { publishSuggestionUpdate, type SuggestionSocketPublisher } from '../../routes/suggestion-routes.js';
import { broughtWorkHandler, type DeskMessage, SuggestionDesk, workCardTitle } from './desk-delivery.js';
import { InMemorySuggestionStore } from './InMemorySuggestionStore.js';
import { RedisSuggestionStore } from './RedisSuggestionStore.js';
import { type SuggestionActor, SuggestionService } from './SuggestionService.js';
import { SuggestionActionRegistry } from './suggestion-actions.js';

interface StoredMessageLike {
  userId: string;
  threadId: string;
  extra?: { rich?: { blocks?: readonly unknown[] } };
}

/** The saved message as the desk reads it (its work cards). */
export function deskMessage(message: StoredMessageLike): DeskMessage {
  return { userId: message.userId, threadId: message.threadId, blocks: message.extra?.rich?.blocks ?? [] };
}

export interface SuggestionIntegrationDeps {
  watcherOutputFence?: import('./SuggestionService.js').SuggestionServiceDeps['watcherOutputFence'];
  redis?: RedisClient;
  messageStore: {
    getById(id: string): StoredMessageLike | null | Promise<StoredMessageLike | null>;
  };
  threadTitle?(threadId: string): Promise<string | undefined>;
  /** The rich-block buffer of in-flight turns (a reply's cards land when the turn ends). */
  richBlocks?: {
    hasPendingBlock(
      threadId: string,
      catId: string,
      invocationIds: readonly string[],
      match: (block: unknown) => boolean,
    ): boolean;
  };
  invocationTracker?: {
    getLifecycleResponseMessageId(threadId: string, catId: string, invocationId: string): string | undefined;
  };
  socketManager?: SuggestionSocketPublisher | null;
  now?: () => number;
  newId?: () => string;
}

/**
 * F335 交付二 / 三的组装：一份存储（Redis，TTL=0；无 Redis 时内存）、一张动作表、一个服务、一个桌面投递。
 * 动作在各自依赖就绪处登记（定时任务、作品批注；线 1 的暂停 / 关闭也登记到同一张表）。
 */
export function createSuggestionIntegration(deps: SuggestionIntegrationDeps) {
  const registry = new SuggestionActionRegistry();
  const store = deps.redis ? new RedisSuggestionStore(deps.redis) : new InMemorySuggestionStore();
  const turnMessageId = (actor: SuggestionActor) => {
    const tracker = deps.invocationTracker;
    if (!tracker) return undefined;
    for (const invocationId of [actor.invocationId, actor.parentInvocationId]) {
      if (!invocationId) continue;
      const id = tracker.getLifecycleResponseMessageId(actor.threadId, actor.catId, invocationId);
      if (id) return id;
    }
    return undefined;
  };
  const service = new SuggestionService({
    ...(deps.watcherOutputFence ? { watcherOutputFence: deps.watcherOutputFence } : {}),
    store,
    registry,
    loadMessage: async (id) => {
      const message = await deps.messageStore.getById(id);
      return message ? { userId: message.userId, threadId: message.threadId } : null;
    },
    resolveTurnMessageId: turnMessageId,
    publish: (threadId, view) => publishSuggestionUpdate(deps.socketManager, threadId, view),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.newId ? { newId: deps.newId } : {}),
  });
  registry.register(broughtWorkHandler);
  const desk = new SuggestionDesk({
    service,
    store,
    loadMessage: async (id) => {
      const message = await deps.messageStore.getById(id);
      return message ? deskMessage(message) : null;
    },
    ...(deps.threadTitle ? { threadTitle: deps.threadTitle } : {}),
    ...(deps.richBlocks
      ? {
          cardPending: (actor, work) =>
            deps.richBlocks?.hasPendingBlock(
              actor.threadId,
              actor.catId,
              [actor.invocationId, actor.parentInvocationId].filter((id): id is string => Boolean(id)),
              (block) => workCardTitle(block, work) !== null,
            ) === true,
        }
      : {}),
  });
  return { registry, service, desk };
}
