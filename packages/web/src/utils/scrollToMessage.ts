import { revealFoldedSourceAnchor } from './folded-source-navigation';

export const MOUNT_DEFERRED_MESSAGE_EVENT = 'cat-cafe:mount-deferred-message';
export const MESSAGE_VIEWPORT_MOUNTED_EVENT = 'cat-cafe:message-viewport-mounted';

export interface MessageScrollAnchor {
  messageId: string;
  viewportOffsetPx: number;
}

function messageBoundaries(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-message-viewport-id]')];
}

/** Project the top visible message into stable identity + viewport-relative geometry. */
export function captureMessageScrollAnchor(container: HTMLElement): MessageScrollAnchor | undefined {
  const viewport = container.getBoundingClientRect();
  const boundary = messageBoundaries(container).find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return rect.bottom > viewport.top && rect.top < viewport.bottom;
  });
  const messageId = boundary?.dataset.messageViewportId;
  if (!boundary || !messageId) return undefined;
  return {
    messageId,
    viewportOffsetPx: boundary.getBoundingClientRect().top - viewport.top,
  };
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
  const currentOffset = boundary.getBoundingClientRect().top - container.getBoundingClientRect().top;
  container.scrollTop = Math.max(0, container.scrollTop + currentOffset - anchor.viewportOffsetPx);
  return true;
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

  // Temporary blue ring highlight
  el.classList.add('ring-2', 'ring-blue-400', 'transition-all');
  setTimeout(() => {
    el.classList.remove('ring-2', 'ring-blue-400');
  }, 1500);
  return true;
}
