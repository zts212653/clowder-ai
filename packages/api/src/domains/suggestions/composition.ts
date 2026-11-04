import type { RedisClient } from '@cat-cafe/shared/utils';
import { publishSuggestionUpdate, type SuggestionSocketPublisher } from '../../routes/suggestion-routes.js';
import { InMemorySuggestionStore } from './InMemorySuggestionStore.js';
import { RedisSuggestionStore } from './RedisSuggestionStore.js';
import { type SuggestionActor, SuggestionService } from './SuggestionService.js';
import { SuggestionActionRegistry } from './suggestion-actions.js';

export interface SuggestionIntegrationDeps {
  redis?: RedisClient;
  messageStore: {
    getById(
      id: string,
    ): { userId: string; threadId: string } | null | Promise<{ userId: string; threadId: string } | null>;
  };
  invocationTracker?: {
    getLifecycleResponseMessageId(threadId: string, catId: string, invocationId: string): string | undefined;
  };
  socketManager?: SuggestionSocketPublisher | null;
}

/**
 * F335 交付二的组装：一份存储（Redis，TTL=0；无 Redis 时内存）、一张动作表、一个服务。
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
    store,
    registry,
    loadMessage: async (id) => {
      const message = await deps.messageStore.getById(id);
      return message ? { userId: message.userId, threadId: message.threadId } : null;
    },
    resolveTurnMessageId: turnMessageId,
    publish: (threadId, view) => publishSuggestionUpdate(deps.socketManager, threadId, view),
  });
  return { registry, service };
}
