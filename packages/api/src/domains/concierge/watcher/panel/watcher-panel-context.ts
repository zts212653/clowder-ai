import { estimateTokens } from '../../../../utils/token-counter.js';
import { getMessageDisplayName } from '../../../cats/services/context/ContextAssembler.js';
import { isDisplayOnlySystemMessage } from '../../../cats/services/stores/host-message-policy.js';
import type { IMessageStore, StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import { awaitStoreRead } from '../../../cats/services/stores/ports/StoreReadOptions.js';

/** Fresh member: like an ordinary cat entering the thread — a large recent window, the rest paged by itself. */
export const WATCHER_PANEL_COLD_BUDGET_TOKENS = 100_000;
/** Resumed member: everything since its own last cutoff, within this bound. */
export const WATCHER_PANEL_HOT_BUDGET_TOKENS = 80_000;
const MAX_MESSAGES = 1500;
const PAGE = 100;
/** One huge log must not starve the rest of the window; the member can read it whole with get_message. */
const MAX_BODY_CHARS = 12_000;

export interface WatcherPanelContextWindow {
  mode: 'cold' | 'hot';
  body: string;
  messageCount: number;
  firstMessageId?: string;
  /** Older (cold) or intermediate (hot) originals were left out of the prompt. */
  truncated: boolean;
}

export const watcherMessageTime = (message: Pick<StoredMessage, 'timelineOrderAt' | 'timestamp'>) =>
  message.timelineOrderAt ?? message.timestamp;

function visible(message: StoredMessage, userId: string, threadId: string): boolean {
  return (
    message.threadId === threadId &&
    !message.deletedAt &&
    message.visibility !== 'whisper' &&
    !isDisplayOnlySystemMessage(message) &&
    (message.userId === userId || message.from?.kind !== 'user')
  );
}

function render(message: StoredMessage): string {
  const withdrawn = message._tombstone || message.recall;
  const raw = withdrawn ? '[原消息已撤回]' : (message.content ?? '');
  const body =
    raw.length > MAX_BODY_CHARS
      ? `${raw.slice(0, MAX_BODY_CHARS)}\n…（原文 ${raw.length} 字，后面没放进来；全文用 get_message 读 ${message.id}）`
      : raw;
  const at = new Date(watcherMessageTime(message)).toISOString();
  return `<原话 messageId="${message.id}" from="${getMessageDisplayName(message)}" at="${at}">\n${body}\n</原话>`;
}

/** Newest-first originals fit into the budget, then render oldest-first. */
function pack(newestFirst: StoredMessage[], budget: number, mode: 'cold' | 'hot', more: boolean) {
  const kept: string[] = [];
  const ids: string[] = [];
  let used = 0;
  let truncated = more;
  for (const message of newestFirst) {
    const text = render(message);
    const cost = estimateTokens(text);
    if (kept.length > 0 && used + cost > budget) {
      truncated = true;
      break;
    }
    kept.push(text);
    ids.push(message.id);
    used += cost;
  }
  kept.reverse();
  ids.reverse();
  return {
    mode,
    body: kept.join('\n'),
    messageCount: ids.length,
    ...(ids[0] ? { firstMessageId: ids[0] } : {}),
    truncated,
  } satisfies WatcherPanelContextWindow;
}

export async function watcherPanelContext(input: {
  messages: IMessageStore;
  userId: string;
  threadId: string;
  /** The judged turn's settlement time; a reply is written until then, so its id cannot be the lock. */
  cutoffAt: number;
  /** Resumed member: its previous lock, and the replies settled since then that began before it. */
  since?: { at: number; settledReplyIds: readonly string[] };
  signal?: AbortSignal;
}): Promise<WatcherPanelContextWindow> {
  const read = <T>(value: T | Promise<T>) => awaitStoreRead(Promise.resolve(value), { signal: input.signal });
  const budget = input.since ? WATCHER_PANEL_HOT_BUDGET_TOKENS : WATCHER_PANEL_COLD_BUDGET_TOKENS;
  const collected: StoredMessage[] = [];
  let timestamp = input.cutoffAt + 1;
  let beforeId: string | undefined;
  let more = false;
  let tokens = 0;
  pages: while (collected.length < MAX_MESSAGES) {
    const page = await read(input.messages.getByThreadBefore(input.threadId, timestamp, PAGE, beforeId, input.userId));
    if (page.length === 0) break;
    for (const message of [...page].reverse()) {
      if (input.since && watcherMessageTime(message) <= input.since.at) break pages;
      if (!visible(message, input.userId, input.threadId)) continue;
      collected.push(message);
      tokens += estimateTokens(message.content?.slice(0, MAX_BODY_CHARS) ?? '');
    }
    const oldest = page[0]!;
    timestamp = watcherMessageTime(oldest);
    beforeId = oldest.id;
    if (page.length < PAGE) break;
    if (tokens > budget) {
      more = true;
      break;
    }
  }
  if (input.since) {
    const seen = new Set(collected.map((message) => message.id));
    for (const id of input.since.settledReplyIds) {
      if (seen.has(id)) continue;
      const reply = await read(input.messages.getById(id));
      if (reply && visible(reply, input.userId, input.threadId) && watcherMessageTime(reply) <= input.cutoffAt)
        collected.push(reply);
    }
    collected.sort((left, right) => watcherMessageTime(right) - watcherMessageTime(left));
  }
  return pack(collected, budget, input.since ? 'hot' : 'cold', more || collected.length >= MAX_MESSAGES);
}
