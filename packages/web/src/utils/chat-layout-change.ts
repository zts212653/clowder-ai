export const CHAT_LAYOUT_CHANGED_EVENT = 'catcafe:chat-layout-changed';

export interface ChatLayoutViewportAnchor {
  element: Element;
  viewportTop: number;
  fallbackScrollTop: number;
}

interface ChatLayoutChangeDetail {
  viewportAnchor?: ChatLayoutViewportAnchor;
}

export function dispatchChatLayoutChanged(detail?: ChatLayoutChangeDetail): void {
  window.dispatchEvent(
    detail
      ? new CustomEvent<ChatLayoutChangeDetail>(CHAT_LAYOUT_CHANGED_EVENT, { detail })
      : new Event(CHAT_LAYOUT_CHANGED_EVENT),
  );
}

export function readChatLayoutViewportAnchor(event: Event): ChatLayoutViewportAnchor | null {
  if (!(event instanceof CustomEvent)) return null;
  const candidate = (event as CustomEvent<ChatLayoutChangeDetail>).detail?.viewportAnchor;
  if (
    !candidate ||
    !(candidate.element instanceof Element) ||
    !Number.isFinite(candidate.viewportTop) ||
    !Number.isFinite(candidate.fallbackScrollTop)
  ) {
    return null;
  }
  return candidate;
}
