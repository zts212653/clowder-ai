import { type RefObject, useEffect } from 'react';
import { captureChatReadingBeforeLayoutChange } from '@/utils/chat-layout-change';
import {
  CHAT_READING_INPUT_FENCE_EVENT,
  type ChatReadingInputFence,
  readChatReadingInputFenceRequest,
} from '@/utils/chat-reading-input-fence';
import { chatReadingClock } from '@/utils/chat-restore-write-checkpoint';
import { isValidWidgetProofRequestId } from './html-widget-layout-machine';

export const WIDGET_INPUT_FENCE_REQUEST = 'cat-cafe:html-widget-input-fence-request';
export const WIDGET_INPUT_FENCE_ACK = 'cat-cafe:html-widget-input-fence-ack';
let nextRequestId = 0;

function readAcknowledgement(
  event: MessageEvent<unknown>,
  source: Window | null,
  blockId: string,
  instanceId: string,
): { requestId: string; inputOccurredAt?: number } | null {
  if (!source || event.source !== source || event.origin !== 'null' || !event.data || typeof event.data !== 'object')
    return null;
  const message = event.data as Record<string, unknown>;
  if (
    message.type !== WIDGET_INPUT_FENCE_ACK ||
    message.v !== 6 ||
    message.blockId !== blockId ||
    message.instanceId !== instanceId ||
    !isValidWidgetProofRequestId(message.requestId)
  )
    return null;
  const at = message.inputOccurredAt;
  if (at !== undefined && (typeof at !== 'number' || !Number.isFinite(at) || at <= 0)) return null;
  if (typeof at === 'number' && at > chatReadingClock()) return null;
  return { requestId: message.requestId, ...(typeof at === 'number' ? { inputOccurredAt: at } : {}) };
}

/** Acknowledges the child's input queue without changing layout/proof state. */
export function useHtmlWidgetInputFence(
  widgetRef: RefObject<HTMLElement | null>,
  iframeRef: RefObject<HTMLIFrameElement | null>,
  blockId: string,
  instanceId: string,
  html: string,
  isExport: boolean,
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: replacing the iframe document retires its pending acknowledgements
  useEffect(() => {
    if (isExport) return;
    const requests = new Map<string, { source: Window; finish: (confirmed: boolean) => void }>();
    const onRequest = (event: Event) => {
      const request = readChatReadingInputFenceRequest(event);
      const widget = widgetRef.current;
      if (!request || !widget || widget.closest('[data-chat-container]') !== request.viewport) return;
      const source = iframeRef.current?.contentWindow;
      if (!source) {
        request.enroll({ result: Promise.resolve(false), cancel: () => {} });
        return;
      }
      const requestId = `reading:${++nextRequestId}`;
      let finish!: (confirmed: boolean) => void;
      const fence: ChatReadingInputFence = {
        result: new Promise<boolean>((resolve) => {
          finish = (confirmed) => {
            requests.delete(requestId);
            resolve(confirmed);
          };
        }),
        cancel: () => finish(false),
      };
      requests.set(requestId, { source, finish });
      request.enroll(fence);
      source.postMessage({ type: WIDGET_INPUT_FENCE_REQUEST, v: 6, blockId, instanceId, requestId }, '*');
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      const message = readAcknowledgement(event, iframeRef.current?.contentWindow ?? null, blockId, instanceId);
      if (!message) return;
      const pending = requests.get(message.requestId);
      if (!pending || pending.source !== event.source) return;
      const at = message.inputOccurredAt;
      // Child input sends and this acknowledgement share the same sender queue.
      // Also carry its latest epoch, so a prior input cannot be hidden by delivery delay.
      if (typeof at === 'number') captureChatReadingBeforeLayoutChange(at);
      pending.finish(true);
    };
    window.addEventListener(CHAT_READING_INPUT_FENCE_EVENT, onRequest);
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener(CHAT_READING_INPUT_FENCE_EVENT, onRequest);
      window.removeEventListener('message', onMessage);
      for (const pending of [...requests.values()]) pending.finish(false);
    };
    // Content replacement retires acknowledgements from the previous document.
  }, [blockId, instanceId, html, isExport, widgetRef, iframeRef]);
}
