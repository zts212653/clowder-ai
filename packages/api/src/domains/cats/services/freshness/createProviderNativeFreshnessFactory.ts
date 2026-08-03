import type { CatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { InvocationDeps } from '../agents/invocation/invoke-single-cat.js';
import type { DeliveryCursorStore } from '../stores/ports/DeliveryCursorStore.js';
import { isDelivered, type StoredMessage } from '../stores/ports/MessageStore.js';
import type { IThreadStore } from '../stores/ports/ThreadStore.js';
import { canViewMessage } from '../stores/visibility.js';
import {
  createQueueChecker,
  type FreshnessMessageReader,
  type QueuedMessageChecker,
} from './checkFreshnessForPostMessage.js';
import { FreshnessAttentionEventLog } from './FreshnessAttentionEventLog.js';
import { bindFreshnessNoticeBroker, FreshnessNoticeBroker } from './FreshnessNoticeBroker.js';
import { ThreadUnseenChecker } from './ThreadUnseenChecker.js';

interface ProviderNativeFreshnessFactoryDeps {
  redis: RedisClient;
  cursorStore: DeliveryCursorStore;
  messageStore: FreshnessMessageReader;
  threadStore: IThreadStore;
  getQueue?: () => Parameters<typeof createQueueChecker>[0] | null;
}

export function createProviderNativeFreshnessFactory(
  deps: ProviderNativeFreshnessFactoryDeps,
): NonNullable<InvocationDeps['providerNativeFreshnessFactory']> {
  return async ({ invocationId, threadId, userId, catId, capability }) => {
    const thread = await deps.threadStore.get(threadId);
    const playMode = (thread?.thinkingMode ?? 'debug') === 'play';
    const viewer = playMode ? ({ type: 'cat', catId } as const) : ({ type: 'user' } as const);
    const messageFilter = (message: Record<string, unknown>): boolean => {
      const stored = message as unknown as StoredMessage;
      if (stored.deletedAt || !isDelivered(stored) || stored.origin === 'briefing') return false;
      if (!playMode) return true;
      if (!canViewMessage(stored, viewer)) return false;
      return stored.origin !== 'stream' || !stored.catId || stored.catId === catId;
    };
    const queue = deps.getQueue?.();
    const queueChecker: QueuedMessageChecker | undefined = queue ? createQueueChecker(queue) : undefined;
    const unseenChecker = new ThreadUnseenChecker({
      userId,
      cursorStore: deps.cursorStore,
      messageStore: deps.messageStore,
      messageFilter,
      ...(queueChecker ? { queueChecker } : {}),
    });
    const eventLog = new FreshnessAttentionEventLog(deps.redis);
    const broker = new FreshnessNoticeBroker({
      context: { invocationId, threadId, catId: catId as CatId },
      checkUnseen: () => unseenChecker.checkUnseen({ threadId, catId }),
      appendEvent: (event) => eventLog.append(event),
    });
    return bindFreshnessNoticeBroker(broker, capability);
  };
}
