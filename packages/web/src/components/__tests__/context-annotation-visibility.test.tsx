import type { QuoteContextAttachment } from '@cat-cafe/shared';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageAnnotationActions } from '../MessageAnnotationActions';
import { getContextAttachmentDraft, syncContextAttachmentDraftToStorage } from '../thread-drafts';
import { useMessageAnnotationMarkers } from '../useMessageAnnotationMarkers';

const attachments: QuoteContextAttachment[] = ['first words', 'second words'].map((text, index) => ({
  v: 1,
  id: `quote-${index + 1}`,
  kind: 'quote',
  text,
  comment: `keep comment ${index + 1}`,
  selectionStart: index === 0 ? 0 : 12,
  selectionEnd: index === 0 ? 11 : 24,
  source: { kind: 'message', threadId: 'marker-thread', messageId: 'original-message' },
}));

function Harness() {
  const ref = useRef<HTMLElement>(null);
  const markers = useMessageAnnotationMarkers(ref, 'marker-thread', 'original-message');
  return (
    <div data-testid="quote-viewport" style={{ overflow: 'auto' }}>
      <article ref={ref} data-testid="quote-source">
        first words second words
      </article>
      <MessageAnnotationActions markers={markers} onSave={() => {}} onDelete={() => {}} />
    </div>
  );
}

describe('text annotation visibility follows its original source', () => {
  let host: HTMLDivElement;
  let root: Root;
  let rangeTop: number;
  let rangeRight: number;
  let covering: Element | null;
  let resizeCallbacks: ResizeObserverCallback[];
  const marker = () => document.querySelector<HTMLElement>('[data-testid="context-annotation-marker-quote-1"]');
  const rangeDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');
  const paintDescriptor = Object.getOwnPropertyDescriptor(document, 'elementsFromPoint');

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    rangeTop = 120;
    rangeRight = 260;
    covering = null;
    resizeCallbacks = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      x: 100,
      y: 100,
      top: 100,
      left: 100,
      right: 400,
      bottom: 300,
      width: 300,
      height: 200,
      toJSON() {},
    }));
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value() {
        return {
          top: rangeTop,
          left: 120,
          right: rangeRight,
          bottom: rangeTop + 20,
          width: rangeRight - 120,
          height: 20,
        };
      },
    });
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [covering ?? host.querySelector('[data-testid="quote-source"]')],
    });
    syncContextAttachmentDraftToStorage('marker-thread', attachments);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<Harness />));
    expect(marker()?.textContent).toBe('1');
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    covering?.remove();
    syncContextAttachmentDraftToStorage('marker-thread', []);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (rangeDescriptor) Object.defineProperty(Range.prototype, 'getBoundingClientRect', rangeDescriptor);
    else Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
    if (paintDescriptor) Object.defineProperty(document, 'elementsFromPoint', paintDescriptor);
    else Reflect.deleteProperty(document, 'elementsFromPoint');
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('hides behind an opened work and restores both original numbers and untouched draft', async () => {
    const original = getContextAttachmentDraft('marker-thread');
    const work = document.createElement('div');
    covering = work;
    work.setAttribute('role', 'dialog');
    work.setAttribute('aria-modal', 'true');
    await act(async () => document.body.append(work));
    expect(marker()).toBeNull();
    covering = null;
    await act(async () => work.remove());
    expect(marker()?.textContent).toBe('1');
    expect(document.querySelector('[data-testid="context-annotation-marker-quote-2"]')?.textContent).toBe('2');
    expect(getContextAttachmentDraft('marker-thread')).toBe(original);
  });

  it('hides after its text scrolls outside the chat viewport while still inside the window', () => {
    rangeTop = 350;
    act(() => document.dispatchEvent(new Event('scroll')));
    expect(marker()).toBeNull();
  });

  it('keeps the badge inside the chat instead of spilling into the neighboring work', () => {
    rangeRight = 399;
    act(() => window.dispatchEvent(new Event('resize')));
    const badge = marker();
    if (!badge) throw new Error('visible original text must retain its badge');
    expect(Number.parseFloat(badge.style.left) + 28).toBeLessThanOrEqual(400);
  });

  it('recomputes after the original container resizes without a window resize', () => {
    rangeRight = 200;
    act(() =>
      resizeCallbacks.forEach((callback) => {
        callback([], {} as ResizeObserver);
      }),
    );
    expect(marker()?.style.left).toBe('208px');
  });

  it('hides when work mode makes the original chat invisible and restores on return', async () => {
    const viewport = host.querySelector<HTMLElement>('[data-testid="quote-viewport"]');
    if (!viewport) throw new Error('original quote viewport missing');
    await act(async () => {
      viewport.style.visibility = 'hidden';
    });
    expect(marker()).toBeNull();
    await act(async () => {
      viewport.style.visibility = 'visible';
    });
    expect(marker()?.textContent).toBe('1');
  });
});
