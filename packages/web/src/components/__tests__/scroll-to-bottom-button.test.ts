import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

function defineNumberProp(target: object, key: string, value: number) {
  Object.defineProperty(target, key, { value, configurable: true });
}

describe('ScrollToBottomButton', () => {
  let container: HTMLDivElement;
  let root: Root;
  let scrollEl: HTMLDivElement;
  let endEl: HTMLDivElement;
  let onJumpToLatest: Mock<() => void>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    scrollEl = document.createElement('div');
    endEl = document.createElement('div');
    scrollEl.appendChild(endEl);

    // jsdom doesn't compute scroll metrics; define them explicitly
    defineNumberProp(scrollEl, 'clientHeight', 100);
    defineNumberProp(scrollEl, 'scrollHeight', 300);
    defineNumberProp(scrollEl, 'scrollTop', 200); // at bottom (300 - 100)

    endEl.scrollIntoView = vi.fn();
    onJumpToLatest = vi.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('hidden when already at bottom; shows when scrolled up; click scrolls to bottom', async () => {
    const { ScrollToBottomButton } = await import('@/components/ScrollToBottomButton');

    const scrollRef = { current: scrollEl } as React.RefObject<HTMLElement>;
    const endRef = { current: endEl } as React.RefObject<HTMLElement>;

    act(() => {
      root.render(
        React.createElement(ScrollToBottomButton, {
          scrollContainerRef: scrollRef,
          messagesEndRef: endRef,
          onJumpToLatest,
        }),
      );
    });

    expect(container.querySelector('button[aria-label="到最新"]')).toBeNull();

    // Scroll up
    defineNumberProp(scrollEl, 'scrollTop', 0);
    act(() => {
      scrollEl.dispatchEvent(new Event('scroll'));
    });

    const btn = container.querySelector('button[aria-label="到最新"]');
    expect(btn).toBeTruthy();

    act(() => {
      (btn as HTMLButtonElement).click();
    });

    expect(onJumpToLatest).toHaveBeenCalledTimes(1);
    expect(endEl.scrollIntoView).not.toHaveBeenCalled();
  });

  it('recomputes visibility when thread/content changes without scroll events (cloud P2)', async () => {
    const { ScrollToBottomButton } = await import('@/components/ScrollToBottomButton');

    const scrollRef = { current: scrollEl } as React.RefObject<HTMLElement>;
    const endRef = { current: endEl } as React.RefObject<HTMLElement>;

    // Start scrolled up → visible
    defineNumberProp(scrollEl, 'scrollTop', 0);
    act(() => {
      root.render(
        React.createElement(ScrollToBottomButton, {
          scrollContainerRef: scrollRef,
          messagesEndRef: endRef,
          onJumpToLatest,
          recomputeSignal: 'thread-A',
        }),
      );
    });

    expect(container.querySelector('button[aria-label="到最新"]')).toBeTruthy();

    // Thread switch / content replacement: scrollTop changes, but no scroll event fired.
    defineNumberProp(scrollEl, 'scrollTop', 200); // at bottom
    act(() => {
      root.render(
        React.createElement(ScrollToBottomButton, {
          scrollContainerRef: scrollRef,
          messagesEndRef: endRef,
          onJumpToLatest,
          recomputeSignal: 'thread-B',
        }),
      );
    });

    expect(container.querySelector('button[aria-label="到最新"]')).toBeNull();
  });

  it('recomputes visibility on local layout change events (cloud P2)', async () => {
    const { ScrollToBottomButton } = await import('@/components/ScrollToBottomButton');

    const scrollRef = { current: scrollEl } as React.RefObject<HTMLElement>;
    const endRef = { current: endEl } as React.RefObject<HTMLElement>;

    // At bottom → hidden
    defineNumberProp(scrollEl, 'scrollTop', 200);
    act(() => {
      root.render(
        React.createElement(ScrollToBottomButton, {
          scrollContainerRef: scrollRef,
          messagesEndRef: endRef,
          onJumpToLatest,
          recomputeSignal: 'base',
        }),
      );
    });
    expect(container.querySelector('button[aria-label="到最新"]')).toBeNull();

    // Local expansion (e.g. ThinkingContent) grows scrollHeight without scroll/resize events.
    defineNumberProp(scrollEl, 'scrollHeight', 500);
    act(() => {
      window.dispatchEvent(new Event('catcafe:chat-layout-changed'));
    });

    expect(container.querySelector('button[aria-label="到最新"]')).toBeTruthy();
  });

  it('recomputes visibility on media-driven layout changes via IntersectionObserver (cloud P2)', async () => {
    const { ScrollToBottomButton } = await import('@/components/ScrollToBottomButton');

    const original = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    let callback: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;

    class TestIntersectionObserver {
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
        callback = cb;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    }

    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = TestIntersectionObserver as unknown;

    try {
      const scrollRef = { current: scrollEl } as React.RefObject<HTMLElement>;
      const endRef = { current: endEl } as React.RefObject<HTMLElement>;

      // Start at bottom → hidden
      defineNumberProp(scrollEl, 'scrollTop', 200);
      act(() => {
        root.render(
          React.createElement(ScrollToBottomButton, {
            scrollContainerRef: scrollRef,
            messagesEndRef: endRef,
            onJumpToLatest,
            recomputeSignal: 'base',
          }),
        );
      });

      expect(callback).toBeTruthy();
      expect(container.querySelector('button[aria-label="到最新"]')).toBeNull();

      // Media load / layout shift pushes the end sentinel out of view without scroll/resize.
      act(() => {
        callback?.([{ isIntersecting: false }]);
      });

      expect(container.querySelector('button[aria-label="到最新"]')).toBeTruthy();
    } finally {
      (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = original;
    }
  });
});
