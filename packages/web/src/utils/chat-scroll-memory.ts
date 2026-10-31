import type { ChatMessage } from '@/stores/chat-types';
import { getMessageTimelineOrderTime } from '@/stores/message-timeline';
import type { MessageScrollAnchor } from './scrollToMessage';

export type SavedScrollState =
  | { top: number; anchor: 'bottom' }
  | { top: number; anchor: 'offset'; messageAnchor?: MessageScrollAnchor };

export interface ChatReadingSnapshot {
  threadId: string;
  position: SavedScrollState;
}

/** A reading-owner locator, never a message authorization or geometry contract. */
export type ChatReadingRef = string;

export interface CapturedChatReadingRef {
  ref: ChatReadingRef;
  persisted: boolean;
}

// The history owner keeps only reading geometry here, never message bodies or
// workspace/navigation authority. Browser-local state has no expiry.
const positions = new Map<string, SavedScrollState>();
const KEY_PREFIX = 'cat-cafe:thread-scroll:';
const REF_PREFIX = 'cat-cafe:thread-scroll-ref:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseState(state: unknown): SavedScrollState | undefined {
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

function readPosition(key: string): SavedScrollState | undefined {
  const current = positions.get(key);
  if (current || typeof window === 'undefined') return current;
  try {
    const raw = window.localStorage.getItem(key);
    const record: unknown = raw ? JSON.parse(raw) : null;
    if (!record || typeof record !== 'object' || !('v' in record) || record.v !== 1 || !('state' in record)) return;
    const persisted = parseState(record.state);
    if (persisted) positions.set(key, persisted);
    return persisted;
  } catch {
    return undefined;
  }
}

function savePosition(key: string, state: SavedScrollState): boolean {
  positions.set(key, state);
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(key, JSON.stringify({ v: 1, state }));
    return true;
  } catch {
    // Preserve same-page navigation, while callers can report that reload recovery is unavailable.
    return false;
  }
}

function readingRefParts(ref: ChatReadingRef): { threadId: string; id: string } | undefined {
  const match = /^chat-reading:([^:]+):(.+)$/.exec(ref);
  if (!match || !UUID.test(match[2])) return;
  const threadId = new URLSearchParams(`thread=${match[1]}`).get('thread');
  if (!threadId || encodeURIComponent(threadId) !== match[1]) return;
  return { threadId, id: match[2] };
}

/** Immutable record keys prevent current-position writers from replacing a return point. */
export function captureChatReadingRef(snapshot: ChatReadingSnapshot): CapturedChatReadingRef | null {
  const position = parseState(snapshot.position);
  if (!snapshot.threadId.trim() || !position) return null;
  if (position.anchor === 'offset' && !position.messageAnchor) return null;
  const id = crypto.randomUUID();
  const persisted = savePosition(`${REF_PREFIX}${encodeURIComponent(snapshot.threadId)}:${id}`, position);
  return { ref: `chat-reading:${encodeURIComponent(snapshot.threadId)}:${id}`, persisted };
}

export function readChatReadingRef(ref: ChatReadingRef): ChatReadingSnapshot | undefined {
  const target = readingRefParts(ref);
  if (!target) return;
  const position = readPosition(`${REF_PREFIX}${encodeURIComponent(target.threadId)}:${target.id}`);
  return position ? { threadId: target.threadId, position: structuredClone(position) } : undefined;
}

/** The matching owner releases a checkpoint on explicit completion or retirement of its unreachable trip. */
export function releaseChatReadingRef(ref: ChatReadingRef, threadId: string): boolean {
  const target = readingRefParts(ref);
  if (!target || target.threadId !== threadId) return false;
  const key = `${REF_PREFIX}${encodeURIComponent(threadId)}:${target.id}`;
  if (!readPosition(key) || typeof window === 'undefined') return false;
  try {
    window.localStorage.removeItem(key);
    positions.delete(key);
    return true;
  } catch {
    return false;
  }
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
  return readPosition(`${KEY_PREFIX}${encodeURIComponent(threadId)}`);
}

export function saveChatScrollState(threadId: string, state: SavedScrollState): void {
  savePosition(`${KEY_PREFIX}${encodeURIComponent(threadId)}`, state);
}

/** Test-only: simulate a cold page while retaining its durable browser state. */
export function __resetChatScrollMemoryForTest(): void {
  positions.clear();
}
