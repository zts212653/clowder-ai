import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_VIEWPORT_MOUNTED_EVENT, scrollToMessage } from '@/utils/scrollToMessage';
import { MessageViewportBoundary } from '../MessageViewportBoundary';

describe('MessageViewportBoundary', () => {
  let container: HTMLDivElement;
  let root: Root;
  let observerCallback: IntersectionObserverCallback;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    class FakeIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
      root = null;
      rootMargin = '0px';
      thresholds = [0];
    }
    (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
  });

  it('lets Chromium skip layout and paint for offscreen message subtrees', () => {
    act(() => {
      root.render(
        <MessageViewportBoundary>
          <p>message</p>
        </MessageViewportBoundary>,
      );
    });

    const boundary = container.querySelector<HTMLElement>('[data-message-viewport-boundary]');
    expect(boundary?.className).toContain('[content-visibility:auto]');
    expect(boundary?.className).toContain('hover:[content-visibility:visible]');
    expect(boundary?.className).toContain('focus-within:[content-visibility:visible]');
    expect(boundary?.style.containIntrinsicSize).toBe('auto 240px');
  });

  it('defers an old message subtree until its placeholder approaches the viewport', () => {
    act(() => {
      root.render(
        <MessageViewportBoundary messageId="old-message">
          <p>expensive old message</p>
        </MessageViewportBoundary>,
      );
    });

    expect(container.textContent).not.toContain('expensive old message');
    expect(container.querySelector('[data-deferred-message-id="old-message"]')).not.toBeNull();
    expect(container.querySelector('[data-message-id="old-message"]')).toBeNull();

    act(() => {
      observerCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });

    expect(container.textContent).toContain('expensive old message');
  });

  it('reports one committed deferred-to-mounted transition with the message identity', () => {
    const mounted = vi.fn();
    window.addEventListener(MESSAGE_VIEWPORT_MOUNTED_EVENT, mounted);
    act(() => {
      root.render(
        <MessageViewportBoundary messageId="old-message">
          <p>expensive old message</p>
        </MessageViewportBoundary>,
      );
    });

    const boundary = container.querySelector<HTMLElement>('[data-message-viewport-boundary]');
    expect(boundary?.dataset.messageViewportId).toBe('old-message');
    expect(mounted).not.toHaveBeenCalled();

    act(() => {
      observerCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    act(() => {
      observerCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });

    expect(mounted).toHaveBeenCalledTimes(1);
    expect((mounted.mock.calls[0]?.[0] as CustomEvent<{ messageId: string }>).detail).toEqual({
      messageId: 'old-message',
    });
    window.removeEventListener(MESSAGE_VIEWPORT_MOUNTED_EVENT, mounted);
  });

  it('mounts deferred content before programmatic navigation consumes the target', () => {
    const scrollIntoView = vi.fn();
    act(() => {
      root.render(
        <MessageViewportBoundary messageId="deferred-target">
          <div
            data-message-id="deferred-target"
            data-folded-source-anchor="supplement-1"
            aria-hidden="true"
            className="h-0 overflow-hidden"
            ref={(node) => {
              if (node) node.scrollIntoView = scrollIntoView;
            }}
          >
            mounted target
            <button type="button" hidden data-folded-source-affordance>
              return to source
            </button>
          </div>
        </MessageViewportBoundary>,
      );
    });

    expect(container.textContent).not.toContain('mounted target');

    let found = false;
    act(() => {
      found = scrollToMessage('deferred-target');
    });

    expect(found).toBe(true);
    expect(container.textContent).toContain('mounted target');
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(container.querySelector('[data-message-id="deferred-target"]')?.getAttribute('aria-hidden')).toBe('false');
    expect(container.querySelector<HTMLButtonElement>('[data-folded-source-affordance]')?.hidden).toBe(false);
  });

  it('renders the newest messages eagerly', () => {
    act(() => {
      root.render(
        <MessageViewportBoundary messageId="latest-message" eager>
          <p>latest message</p>
        </MessageViewportBoundary>,
      );
    });

    expect(container.textContent).toContain('latest message');
  });
});
