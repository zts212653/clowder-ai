import { revealFoldedSourceAnchor } from './folded-source-navigation';

export const MOUNT_DEFERRED_MESSAGE_EVENT = 'cat-cafe:mount-deferred-message';
export const MESSAGE_VIEWPORT_MOUNTED_EVENT = 'cat-cafe:message-viewport-mounted';
const MESSAGE_JUMP_FOCUS_DURATION_MS = 3200;
const messageJumpFocusTimers = new WeakMap<HTMLElement, number>();

export interface MessageScrollAnchor {
  messageId: string;
  viewportOffsetPx: number;
  /** Paragraph/tool header inside a long card; absent for collapsed/deferred cards. */
  blockIndex?: number;
  blockFingerprint?: string;
  blockViewportOffsetPx?: number;
}

export type TimelineScrollAnchor = { kind: 'bottom' } | { kind: 'message'; messageAnchor: MessageScrollAnchor };

function messageBoundaries(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-message-viewport-id]')];
}

const READING_BLOCK_SELECTOR = 'p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, [data-reading-disclosure]';

function readingBlocks(boundary: HTMLElement): HTMLElement[] {
  return [...boundary.querySelectorAll<HTMLElement>(READING_BLOCK_SELECTOR)];
}

function readingBlockFingerprint(block: HTMLElement): string | undefined {
  const text = block.textContent?.replace(/\s+/g, ' ').trim().slice(0, 40);
  return text ? `${block.tagName.toLowerCase()}:${text}` : undefined;
}

function resolveReadingBlock(boundary: HTMLElement, anchor: MessageScrollAnchor): HTMLElement | undefined {
  if (anchor.blockIndex === undefined || !anchor.blockFingerprint) return undefined;
  const savedIndex = anchor.blockIndex;
  const blocks = readingBlocks(boundary);
  const indexed = blocks[savedIndex];
  if (indexed && readingBlockFingerprint(indexed) === anchor.blockFingerprint) return indexed;

  let nearest: HTMLElement | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  blocks.forEach((block, index) => {
    if (readingBlockFingerprint(block) !== anchor.blockFingerprint) return;
    const distance = Math.abs(index - savedIndex);
    if (distance < nearestDistance) {
      nearest = block;
      nearestDistance = distance;
    }
  });
  return nearest;
}

function anchorForBoundary(
  container: HTMLElement,
  boundary: HTMLElement,
  preferredBlock?: HTMLElement,
): MessageScrollAnchor | undefined {
  const messageId = boundary.dataset.messageViewportId;
  if (!messageId) return undefined;
  const viewport = container.getBoundingClientRect();
  const blocks = readingBlocks(boundary);
  const block =
    preferredBlock ??
    blocks.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
  const blockIndex = block ? blocks.indexOf(block) : -1;
  const blockFingerprint = block ? readingBlockFingerprint(block) : undefined;
  return {
    messageId,
    viewportOffsetPx: boundary.getBoundingClientRect().top - viewport.top,
    ...(block && blockIndex >= 0 && blockFingerprint
      ? { blockIndex, blockFingerprint, blockViewportOffsetPx: block.getBoundingClientRect().top - viewport.top }
      : {}),
  };
}

/** Project the top visible message into stable identity + viewport-relative geometry. */
export function captureMessageScrollAnchor(container: HTMLElement): MessageScrollAnchor | undefined {
  const viewport = container.getBoundingClientRect();
  const boundary = messageBoundaries(container).find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return rect.bottom > viewport.top && rect.top < viewport.bottom;
  });
  return boundary ? anchorForBoundary(container, boundary) : undefined;
}

/** A deliberate disclosure click makes the clicked control the reading focus before layout changes. */
export function captureMessageScrollAnchorForElement(
  container: HTMLElement,
  element: HTMLElement,
): MessageScrollAnchor | undefined {
  const boundary = element.closest<HTMLElement>('[data-message-viewport-id]');
  if (!boundary) return undefined;
  const visible = anchorForBoundary(container, boundary);
  return visible?.blockIndex === undefined
    ? anchorForBoundary(container, boundary, element.closest<HTMLElement>(READING_BLOCK_SELECTOR) ?? element)
    : visible;
}

/** Capture one explicit navigation target without substituting another visible row. */
export function captureMessageScrollAnchorForMessage(
  container: HTMLElement,
  messageId: string,
): MessageScrollAnchor | undefined {
  const target = resolveMessageElements([messageId], container)[0];
  if (!target) return undefined;
  const boundary = target.closest<HTMLElement>('[data-message-viewport-id]') ?? target;
  return {
    messageId,
    viewportOffsetPx: boundary.getBoundingClientRect().top - container.getBoundingClientRect().top,
  };
}

/** Mount deferred targets synchronously, then return their real message nodes in DOM order. */
export function resolveMessageElements(messageIds: Iterable<string>, root: ParentNode = document): HTMLElement[] {
  if (typeof document === 'undefined') return [];
  const targetIds = new Set(messageIds);
  if (targetIds.size === 0) return [];

  const mountedIds = new Set(
    [...root.querySelectorAll<HTMLElement>('[data-message-id]')]
      .map((candidate) => candidate.dataset.messageId)
      .filter((messageId): messageId is string => Boolean(messageId)),
  );
  const deferredIds = new Set([...targetIds].filter((messageId) => !mountedIds.has(messageId)));
  if (deferredIds.size > 0) {
    for (const placeholder of root.querySelectorAll<HTMLElement>('[data-deferred-message-id]')) {
      const messageId = placeholder.dataset.deferredMessageId;
      if (messageId && deferredIds.has(messageId)) {
        placeholder.dispatchEvent(new Event(MOUNT_DEFERRED_MESSAGE_EVENT));
      }
    }
  }

  return [...root.querySelectorAll<HTMLElement>('[data-message-id]')].filter((candidate) => {
    const messageId = candidate.dataset.messageId;
    return messageId ? targetIds.has(messageId) : false;
  });
}

/** Reapply a saved message anchor after placeholder or content geometry changes. */
export function restoreMessageScrollAnchor(container: HTMLElement, anchor: MessageScrollAnchor): boolean {
  const target = resolveMessageElements([anchor.messageId], container)[0];
  if (!target) return false;
  const boundary = target.closest<HTMLElement>('[data-message-viewport-id]') ?? target;
  const block = resolveReadingBlock(boundary, anchor);
  const anchorNode = block ?? boundary;
  const desiredOffset = block ? (anchor.blockViewportOffsetPx ?? anchor.viewportOffsetPx) : anchor.viewportOffsetPx;
  const currentOffset = anchorNode.getBoundingClientRect().top - container.getBoundingClientRect().top;
  if (Math.abs(currentOffset - desiredOffset) > 0.5) {
    container.scrollTop = Math.max(0, container.scrollTop + currentOffset - desiredOffset);
  }
  return true;
}

/** Restore the user's viewing intent after the same messages change timeline order. */
export function restoreTimelineScrollAnchor(container: HTMLElement, anchor: TimelineScrollAnchor): boolean {
  if (anchor.kind === 'bottom') {
    container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    return true;
  }
  return restoreMessageScrollAnchor(container, anchor.messageAnchor);
}

/** Give every message-navigation path the same temporary, presentation-only target marker. */
export function markMessageJumpTarget(node: HTMLElement): void {
  const existingTimer = messageJumpFocusTimers.get(node);
  if (existingTimer !== undefined) window.clearTimeout(existingTimer);

  node.dataset.messageJumpFocus = 'true';
  const timer = window.setTimeout(() => {
    delete node.dataset.messageJumpFocus;
    messageJumpFocusTimers.delete(node);
  }, MESSAGE_JUMP_FOCUS_DURATION_MS);
  messageJumpFocusTimers.set(node, timer);
}

/**
 * Scroll to a message by ID with smooth animation and temporary highlight.
 * Returns true when the target element was found (so callers can retry on a
 * raf loop until the message DOM has rendered after a thread switch).
 */
export function scrollToMessage(messageId: string): boolean {
  const el = resolveMessageElements([messageId])[0];
  if (!el) return false;

  revealFoldedSourceAnchor(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });

  markMessageJumpTarget(el);
  return true;
}
