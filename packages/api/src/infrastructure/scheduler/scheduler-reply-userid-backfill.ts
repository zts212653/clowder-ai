import type { RedisClient } from '@cat-cafe/shared/utils';
import type { IThreadStore } from '../../domains/cats/services/stores/ports/ThreadStore.js';
import { RedisInvocationRecordStore } from '../../domains/cats/services/stores/redis/RedisInvocationRecordStore.js';
import { RedisMessageStore } from '../../domains/cats/services/stores/redis/RedisMessageStore.js';

const MARKER_KEY = 'migration:f139:scheduler-reply-userid-backfill:v2';
const REPAIRABLE_REPLY_ORIGINS = new Set(['callback', 'stream']);

export interface SchedulerReplyUserIdBackfillResult {
  skipped: boolean;
  repairedMessages: number;
  repairedInvocations: number;
}

interface SchedulerReplyUserIdBackfillDeps {
  redis: RedisClient;
  messageStore: RedisMessageStore;
  invocationRecordStore: RedisInvocationRecordStore;
  threadStore: IThreadStore;
  defaultUserId?: string;
}

function isRepairableOwner(userId: string | null | undefined): userId is string {
  return Boolean(userId && userId !== 'scheduler' && userId !== 'system');
}

export async function runSchedulerReplyUserIdBackfill(
  deps: SchedulerReplyUserIdBackfillDeps,
): Promise<SchedulerReplyUserIdBackfillResult> {
  const existingMarker = await deps.redis.get(MARKER_KEY);
  if (existingMarker) {
    return { skipped: true, repairedMessages: 0, repairedInvocations: 0 };
  }

  const threadOwnerCache = new Map<string, string | null>();
  const resolveThreadOwner = async (threadId: string): Promise<string | null> => {
    if (threadOwnerCache.has(threadId)) return threadOwnerCache.get(threadId) ?? null;
    const thread = await deps.threadStore.get(threadId);
    let owner = thread?.createdBy ?? null;
    if (!isRepairableOwner(owner) && thread?.systemKind === 'eval_domain') {
      owner = isRepairableOwner(deps.defaultUserId) ? deps.defaultUserId : null;
    }
    if (!isRepairableOwner(owner)) owner = null;
    threadOwnerCache.set(threadId, owner);
    return owner;
  };

  let repairedMessages = 0;
  const allMessages = await deps.messageStore.scanAll();
  for (const msg of allMessages) {
    if (msg.userId !== 'scheduler') continue;
    if (!msg.catId || msg.catId === 'system') continue;
    if (typeof msg.origin !== 'string') continue;
    if (!REPAIRABLE_REPLY_ORIGINS.has(msg.origin)) continue;
    const owner = await resolveThreadOwner(msg.threadId);
    if (!isRepairableOwner(owner)) continue;
    await deps.messageStore.reassignUserId(msg.id, owner);
    repairedMessages++;
  }

  let repairedInvocations = 0;
  const allInvocations = await deps.invocationRecordStore.scanAll();
  for (const record of allInvocations) {
    if (record.userId !== 'scheduler') continue;
    if (!record.userMessageId) continue;
    const owner = await resolveThreadOwner(record.threadId);
    if (!isRepairableOwner(owner)) continue;
    const triggerMessage = await deps.messageStore.getById(record.userMessageId);
    if (!triggerMessage) continue;
    if (triggerMessage.threadId !== record.threadId) continue;
    if (triggerMessage.userId !== 'scheduler' || triggerMessage.catId !== 'system') continue;
    await deps.invocationRecordStore.reassignUserId(record.id, owner);
    repairedInvocations++;
  }

  await deps.redis.set(
    MARKER_KEY,
    JSON.stringify({
      repairedMessages,
      repairedInvocations,
      completedAt: Date.now(),
    }),
  );

  return { skipped: false, repairedMessages, repairedInvocations };
}
