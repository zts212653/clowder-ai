import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('scroll viewport bridge — RAF flush on unmount', () => {
  let rafCallbacks: Array<() => void>;
  let originalRAF: typeof requestAnimationFrame;
  let originalCancelRAF: typeof cancelAnimationFrame;

  beforeEach(() => {
    rafCallbacks = [];
    originalRAF = globalThis.requestAnimationFrame;
    originalCancelRAF = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      const id = rafCallbacks.length + 1;
      rafCallbacks.push(cb as () => void);
      return id;
    };
    globalThis.cancelAnimationFrame = (id: number) => {
      if (id > 0 && id <= rafCallbacks.length) {
        rafCallbacks[id - 1] = () => {};
      }
    };
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCancelRAF;
  });

  it('pending RAF flush writes final scrollTop on cleanup', () => {
    const onScrollTopChange = vi.fn();
    const onScrollTopChangeRef = { current: onScrollTopChange };

    const el = {
      scrollTop: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    // Simulate the bridge pattern from CodeViewer/FileContentRenderer
    let rafId = 0;
    const handleScroll = () => {
      if (rafId) return;
      rafId = globalThis.requestAnimationFrame(() => {
        rafId = 0;
        onScrollTopChangeRef.current?.(el.scrollTop);
      });
    };
    el.addEventListener('scroll', handleScroll, { passive: true });

    // User scrolls to 300
    el.scrollTop = 300;
    handleScroll();
    expect(onScrollTopChange).not.toHaveBeenCalled();
    expect(rafId).toBeGreaterThan(0);

    // Unmount happens before RAF fires — cleanup must flush
    el.removeEventListener('scroll', handleScroll);
    if (rafId) {
      globalThis.cancelAnimationFrame(rafId);
      onScrollTopChangeRef.current?.(el.scrollTop);
    }

    expect(onScrollTopChange).toHaveBeenCalledWith(300);
  });

  it('no flush when no pending RAF on cleanup', () => {
    const onScrollTopChange = vi.fn();
    const onScrollTopChangeRef = { current: onScrollTopChange };

    const el = { scrollTop: 100, addEventListener: vi.fn(), removeEventListener: vi.fn() };

    let rafId = 0;
    const handleScroll = () => {
      if (rafId) return;
      rafId = globalThis.requestAnimationFrame(() => {
        rafId = 0;
        onScrollTopChangeRef.current?.(el.scrollTop);
      });
    };
    el.addEventListener('scroll', handleScroll, { passive: true });

    // Scroll fires and RAF executes
    el.scrollTop = 100;
    handleScroll();
    rafCallbacks[0]();

    expect(onScrollTopChange).toHaveBeenCalledWith(100);
    onScrollTopChange.mockClear();

    // Cleanup — no pending RAF, no extra flush
    rafId = 0; // simulates RAF having completed
    el.removeEventListener('scroll', handleScroll);
    if (rafId) {
      globalThis.cancelAnimationFrame(rafId);
      onScrollTopChangeRef.current?.(el.scrollTop);
    }

    expect(onScrollTopChange).not.toHaveBeenCalled();
  });
});
