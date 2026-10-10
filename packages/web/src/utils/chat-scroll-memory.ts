import type { ChatMessage } from '@/stores/chat-types';
import { getMessageTimelineOrderTime } from '@/stores/message-timeline';
import type { MessageScrollAnchor } from './scrollToMessage';

export type SavedScrollState =
  | { top: number; anchor: 'bottom' }
  | { top: number; anchor: 'offset'; messageAnchor?: MessageScrollAnchor };

// The history owner keeps only reading geometry here, never message bodies or
// workspace/navigation authority. Browser-local state has no expiry.
const positions = new Map<string, SavedScrollState>();
const KEY_PREFIX = 'cat-cafe:thread-scroll:';

function parseState(raw: string | null): SavedScrollState | undefined {
  if (!raw) return undefined;
  const record: unknown = JSON.parse(raw);
  if (!record || typeof record !== 'object' || !('v' in record) || record.v !== 1 || !('state' in record)) return;
  const state = record.state;
  if (!state || typeof state !== 'object' || !('top' in state) || !('anchor' in state)) return;
  if (typeof state.top !== 'number' || !Number.isFinite(state.top) || state.top < 0) return;
  if (state.anchor === 'bottom') return { top: state.top, anchor: 'bottom' };
  if (state.anchor !== 'offset') return;
  if (!('messageAnchor' in state) || state.messageAnchor === undefined) return { top: state.top, anchor: 'offset' };
  const anchor = state.messageAnchor;
  if (
    !anchor ||
    typeof anchor !== 'object' ||
    !('messageId' in anchor) ||
    !('viewportOffsetPx' in anchor) ||
    typeof anchor.messageId !== 'string' ||
    !anchor.messageId ||
    typeof anchor.viewportOffsetPx !== 'number' ||
    !Number.isFinite(anchor.viewportOffsetPx)
  )
    return;
  return {
    top: state.top,
    anchor: 'offset',
    messageAnchor: {
      messageId: anchor.messageId,
      viewportOffsetPx: anchor.viewportOffsetPx,
      ...('blockIndex' in anchor &&
      typeof anchor.blockIndex === 'number' &&
      Number.isInteger(anchor.blockIndex) &&
      anchor.blockIndex >= 0 &&
      'blockFingerprint' in anchor &&
      typeof anchor.blockFingerprint === 'string' &&
      anchor.blockFingerprint &&
      'blockViewportOffsetPx' in anchor &&
      typeof anchor.blockViewportOffsetPx === 'number' &&
      Number.isFinite(anchor.blockViewportOffsetPx)
        ? {
            blockIndex: anchor.blockIndex,
            blockFingerprint: anchor.blockFingerprint,
            blockViewportOffsetPx: anchor.blockViewportOffsetPx,
          }
        : {}),
      ...('timelineOrderAt' in anchor &&
      typeof anchor.timelineOrderAt === 'number' &&
      Number.isFinite(anchor.timelineOrderAt)
        ? { timelineOrderAt: anchor.timelineOrderAt }
        : {}),
    },
  };
}

export function describeChatReadingAnchor(
  anchor: MessageScrollAnchor,
  messages: readonly ChatMessage[],
): MessageScrollAnchor {
  const message = messages.find((message) => message.id === anchor.messageId);
  if (!message) return anchor;
  return {
    ...anchor,
    timelineOrderAt: getMessageTimelineOrderTime(message),
  };
}

/** A reading position belongs to one persisted message; a shared invocation never aliases another record. */
export function resolveChatReadingAnchor(
  anchor: MessageScrollAnchor,
  messages: readonly ChatMessage[],
): MessageScrollAnchor | undefined {
  if (messages.some((message) => message.id === anchor.messageId)) return describeChatReadingAnchor(anchor, messages);
  return undefined;
}

/** After a missing identity is covered, keep its place using the next timeline survivor. */
export function findChatReadingSuccessor(
  anchor: MessageScrollAnchor,
  messages: readonly ChatMessage[],
): MessageScrollAnchor | undefined {
  const orderAt = anchor.timelineOrderAt;
  if (orderAt === undefined) return undefined;
  let next: ChatMessage | undefined;
  for (const message of messages) {
    if (message.id.startsWith('draft-')) continue;
    const time = getMessageTimelineOrderTime(message);
    if (time < orderAt || (time === orderAt && message.id <= anchor.messageId)) continue;
    const nextTime = next ? getMessageTimelineOrderTime(next) : undefined;
    if (!next || nextTime === undefined || time < nextTime || (time === nextTime && message.id < next.id))
      next = message;
  }
  return next
    ? describeChatReadingAnchor({ messageId: next.id, viewportOffsetPx: anchor.viewportOffsetPx }, [next])
    : undefined;
}

export function readChatScrollState(threadId: string): SavedScrollState | undefined {
  const current = positions.get(threadId);
  if (current || typeof window === 'undefined') return current;
  try {
    const persisted = parseState(window.localStorage.getItem(`${KEY_PREFIX}${encodeURIComponent(threadId)}`));
    if (persisted) positions.set(threadId, persisted);
    return persisted;
  } catch {
    return undefined;
  }
}

export function saveChatScrollState(threadId: string, state: SavedScrollState): void {
  positions.set(threadId, state);
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`${KEY_PREFIX}${encodeURIComponent(threadId)}`, JSON.stringify({ v: 1, state }));
  } catch {
    // Unavailable browser storage must not prevent same-session navigation.
  }
}

/** Test-only: simulate a cold page while retaining its durable browser state. */
export function __resetChatScrollMemoryForTest(): void {
  positions.clear();
}
