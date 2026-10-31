export const CHAT_LAYOUT_CHANGED_EVENT = 'catcafe:chat-layout-changed';

export interface ChatLayoutViewportAnchor {
  element: Element;
  viewportTop: number;
  fallbackScrollTop: number;
  inputOccurredAt?: number;
}

interface ChatLayoutChangeDetail {
  viewportAnchor?: ChatLayoutViewportAnchor;
  captureCurrentReading?: boolean;
  inputOccurredAt?: number;
}

export function dispatchChatLayoutChanged(detail?: ChatLayoutChangeDetail): void {
  window.dispatchEvent(
    detail
      ? new CustomEvent<ChatLayoutChangeDetail>(CHAT_LAYOUT_CHANGED_EVENT, { detail })
      : new Event(CHAT_LAYOUT_CHANGED_EVENT),
  );
}

/** Capture through the mounted reading owner before an explicit entry changes its layout. */
export function captureChatReadingBeforeLayoutChange(inputOccurredAt?: number): void {
  dispatchChatLayoutChanged({
    captureCurrentReading: true,
    ...(inputOccurredAt === undefined ? {} : { inputOccurredAt }),
  });
}

export function readChatReadingInputTime(event: Event): number | null | undefined {
  if (!(event instanceof CustomEvent)) return undefined;
  const at = (event as CustomEvent<ChatLayoutChangeDetail>).detail?.inputOccurredAt;
  if (at === undefined) return undefined;
  return typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : null;
}

export function isChatReadingCaptureRequest(event: Event): boolean {
  return (
    event instanceof CustomEvent &&
    (event as CustomEvent<ChatLayoutChangeDetail>).detail?.captureCurrentReading === true
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
