import type { UnifiedAttentionItemV1, UnifiedAttentionSourceRead } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { UserMentionHandlingMetadata } from '../domains/cats/services/stores/user-mention-index.js';

export interface UserMentionTodoRead {
  items: UnifiedAttentionItemV1[];
  state: UnifiedAttentionSourceRead;
  recentCount?: number;
  counts?: { today: number; week: number; earlier: number; handled: number };
  period?: UserMentionPeriod;
}

export type UserMentionPeriod = 'recent' | 'today' | 'week' | 'earlier' | 'handled' | 'all';
export interface MentionReadOptions {
  cutover: number;
  now: number;
  period: UserMentionPeriod;
  threads?: {
    get(
      id: string,
    ):
      | { createdBy?: string; title?: string | null }
      | null
      | Promise<{ createdBy?: string; title?: string | null } | null>;
  };
}

/** Shared by the list and bulk preview. The week is rolling, so Monday never hides weekend requests. */
export function classifyUserMentionPeriod(
  timestamp: number,
  cutover: number,
  now: number,
): 'today' | 'week' | 'earlier' {
  if (timestamp < cutover || timestamp < now - 7 * 86400000) return 'earlier';
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return timestamp >= today.getTime() ? 'today' : 'week';
}

/** One canonical pending/handled mention row; personal reads reuse this exact-version producer. */
export function projectUserMentionTodoItem(
  message: StoredMessage,
  userId: string,
  expectedRevision: number,
  handled = false,
  handling?: UserMentionHandlingMetadata,
): UnifiedAttentionItemV1 {
  if (message.userId !== userId) throw new Error('Invalid request owner');
  if (!message.catId) throw new Error('Invalid request author');
  if (!message.mentionsUser) throw new Error('Invalid request signal');
  if (!Number.isSafeInteger(expectedRevision)) throw new Error('Invalid request revision');
  if (expectedRevision < 0) throw new Error('Invalid request revision');
  return {
    decisionRef: handled
      ? `user-mention-handled:${message.threadId}:${message.id}`
      : `user-mention:${message.threadId}`,
    kind: 'user_mention',
    summary: '对话中的请求',
    userMention: {
      threadId: message.threadId,
      threadTitle: message.threadId,
      ...(handled ? { handled: true } : {}),
      expectedRevision,
      messageId: message.id,
      catId: message.catId,
      content: message.content,
      timestamp: message.timestamp,
      ...(handled && handling ? { handledReason: handling.reason, handledAt: handling.handledAt } : {}),
    },
    linkedNeedsMe: [],
  };
}

function mentionPeriodFor(message: StoredMessage, options?: MentionReadOptions) {
  return classifyUserMentionPeriod(message.timestamp, options?.cutover ?? 0, options?.now ?? Date.now());
}

function countMentionPeriods(source: StoredMessage[], handled: StoredMessage[], options?: MentionReadOptions) {
  const counts = { today: 0, week: 0, earlier: 0, handled: handled.length };
  for (const message of source) {
    const period = mentionPeriodFor(message, options);
    if (period === 'earlier') counts.earlier++;
    else {
      counts.week++;
      if (period === 'today') counts.today++;
    }
  }
  return counts;
}

function selectMentionRows(source: StoredMessage[], handled: StoredMessage[], options?: MentionReadOptions) {
  if (!options) return source;
  if (options.period === 'handled') return handled;
  if (options.period === 'all')
    return [...new Map([...handled, ...source].map((message) => [message.id, message])).values()];
  return source.filter((message) => {
    const period = mentionPeriodFor(message, options);
    return options.period === 'recent' || options.period === 'week' ? period !== 'earlier' : period === options.period;
  });
}

export async function readUserMentionTodos(
  messages: Pick<IMessageStore, 'listUserMentionRequests'> &
    Partial<
      Pick<IMessageStore, 'listHandledUserMentions' | 'getUserMentionStateRevisions' | 'getUserMentionHandlingMetadata'>
    >,
  userId: string,
  options?: MentionReadOptions,
): Promise<UserMentionTodoRead> {
  const startedAt = Date.now();
  try {
    const source = await messages.listUserMentionRequests(userId);
    const handled = options && messages.listHandledUserMentions ? await messages.listHandledUserMentions(userId) : [];
    const handlingMetadata =
      (options?.period === 'handled' || options?.period === 'all') && messages.getUserMentionHandlingMetadata
        ? await messages.getUserMentionHandlingMetadata(userId)
        : {};
    const revisions = messages.getUserMentionStateRevisions ? await messages.getUserMentionStateRevisions(userId) : {};
    const counts = countMentionPeriods(source, handled, options);
    const selected = selectMentionRows(source, handled, options);
    const pendingIds = new Set(source.map((message) => message.id));
    const handledIds = new Set(handled.map((message) => message.id));
    const items: UnifiedAttentionItemV1[] = selected.map((message) =>
      projectUserMentionTodoItem(
        message,
        userId,
        revisions[message.threadId] ?? 0,
        options?.period === 'handled' ||
          (options?.period === 'all' && handledIds.has(message.id) && !pendingIds.has(message.id)),
        handlingMetadata[message.id],
      ),
    );
    return {
      items,
      ...(options ? { counts, recentCount: counts.week, period: options.period } : {}),
      state: {
        status: 'available',
        coverage: 'explicit_user_mentions',
        exhaustiveness: 'complete',
        startedAt,
        observedAt: Date.now(),
      },
    };
  } catch {
    return {
      items: [],
      state: {
        status: 'unavailable',
        coverage: 'explicit_user_mentions',
        exhaustiveness: 'unknown',
        startedAt,
        observedAt: Date.now(),
      },
    };
  }
}
