import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScrollAnchor } from '../use-scroll-anchor';

const originalCss = globalThis.CSS;

const rect = (top: number, height: number): DOMRect =>
  ({
    x: 0,
    y: top,
    top,
    right: 240,
    bottom: top + height,
    left: 0,
    width: 240,
    height,
    toJSON: () => ({}),
  }) as DOMRect;

function Harness({ revision }: { revision: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { onScroll } = useScrollAnchor(containerRef, [revision], { selectedThread: null });

  return (
    <div ref={containerRef} data-testid="scroller" onScroll={onScroll}>
      <div data-scroll-occluder="true">Tabs</div>
      <div data-thread-id="current-thread">Current thread title</div>
    </div>
  );
}

describe('useScrollAnchor sticky visibility', () => {
  let contentTop = 220;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    window.sessionStorage.clear();
    window.sessionStorage.setItem('cat-cafe:sidebar:scrollTop', '200');
    contentTop = 220;

    Object.defineProperty(globalThis, 'CSS', {
      value: { escape: (value: string) => value },
      configurable: true,
    });

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'scroller') return rect(0, 600);
      if (this.dataset.scrollOccluder === 'true') return rect(0, 40);
      if (this.dataset.threadId === 'current-thread') {
        const scrollTop = this.parentElement?.scrollTop ?? 0;
        return rect(contentTop - scrollTop, 84);
      }
      return rect(0, 0);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    document.body.replaceChildren();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    Object.defineProperty(globalThis, 'CSS', { value: originalCss, configurable: true });
  });

  it('keeps the first visible thread title below a sticky header after restore and reorder', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => root.render(<Harness revision={0} />));

    const scroller = host.querySelector('[data-testid="scroller"]') as HTMLDivElement;
    const sticky = host.querySelector('[data-scroll-occluder="true"]') as HTMLElement;
    const firstThread = host.querySelector('[data-thread-id="current-thread"]') as HTMLElement;

    expect(scroller.scrollTop).toBe(180);
    expect(firstThread.getBoundingClientRect().top).toBeGreaterThanOrEqual(sticky.getBoundingClientRect().bottom);

    contentTop += 84;
    act(() => root.render(<Harness revision={1} />));

    expect(scroller.scrollTop).toBe(264);
    expect(firstThread.getBoundingClientRect().top).toBeGreaterThanOrEqual(sticky.getBoundingClientRect().bottom);
    expect(window.sessionStorage.getItem('cat-cafe:sidebar:scrollTop')).toBe(String(scroller.scrollTop));

    act(() => root.unmount());
  });

  it('does not reverse the sidebar while a manual downward scroll is still settling', () => {
    window.sessionStorage.removeItem('cat-cafe:sidebar:scrollTop');

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => root.render(<Harness revision={0} />));

    const scroller = host.querySelector('[data-testid="scroller"]') as HTMLDivElement;
    const sticky = host.querySelector('[data-scroll-occluder="true"]') as HTMLElement;
    const firstThread = host.querySelector('[data-thread-id="current-thread"]') as HTMLElement;

    scroller.scrollTop = 200;
    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 72 }));
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(firstThread.getBoundingClientRect().top).toBeLessThan(sticky.getBoundingClientRect().bottom);

    act(() => root.render(<Harness revision={1} />));

    expect(scroller.scrollTop).toBe(200);
    expect(window.sessionStorage.getItem('cat-cafe:sidebar:scrollTop')).toBe('200');

    act(() => root.unmount());
  });

  it('restores the anchored row when the browser resets scrollTop during a snapshot reorder', () => {
    window.sessionStorage.removeItem('cat-cafe:sidebar:scrollTop');

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<Harness revision={0} />));

    const scroller = host.querySelector('[data-testid="scroller"]') as HTMLDivElement;
    scroller.scrollTop = 200;
    act(() => scroller.dispatchEvent(new Event('scroll', { bubbles: true })));

    // Chromium may apply native scroll anchoring before React's layout effect.
    // The snapshot commit must use the last user-observed position, not accept
    // this transient zero as evidence that the user intentionally returned top.
    scroller.scrollTop = 0;
    contentTop += 84;
    act(() => root.render(<Harness revision={1} />));

    expect(scroller.scrollTop).toBe(284);
    expect(window.sessionStorage.getItem('cat-cafe:sidebar:scrollTop')).toBe('284');

    act(() => root.unmount());
  });

  it('does not undo native scrolling before its delayed scroll notification on a status-only refresh', () => {
    window.sessionStorage.removeItem('cat-cafe:sidebar:scrollTop');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<Harness revision={0} />));
    const scroller = host.querySelector('[data-testid="scroller"]') as HTMLDivElement;
    scroller.scrollTop = 200;
    act(() => scroller.dispatchEvent(new Event('scroll', { bubbles: true })));

    // Browser scrolling and React's snapshot commit can precede the coalesced
    // scroll event. A new snapshot has not moved the row in the document.
    scroller.scrollTop = 272;
    act(() => root.render(<Harness revision={1} />));
    expect(scroller.scrollTop).toBe(272);
    act(() => scroller.dispatchEvent(new Event('scroll', { bubbles: true })));
    expect(window.sessionStorage.getItem('cat-cafe:sidebar:scrollTop')).toBe('272');
    act(() => root.unmount());
  });

  it.each([
    ['wheel', () => new WheelEvent('wheel', { bubbles: true, deltaY: -500 })],
    ['touch', () => new Event('touchstart', { bubbles: true })],
    ['scrollbar', () => new Event('pointerdown', { bubbles: true })],
    ['keyboard', () => new KeyboardEvent('keydown', { bubbles: true, key: 'PageUp' })],
  ] as const)('abandons an unreachable restore when the user browses via %s', (_label, input) => {
    window.sessionStorage.setItem('cat-cafe:sidebar:scrollTop', '1200');
    let top = 0;
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(() => top);
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation((value) => {
      top = Math.max(0, Math.min(1000, value));
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<Harness revision={0} />));
    const scroller = host.querySelector('[data-testid="scroller"]') as HTMLDivElement;
    expect(scroller.scrollTop).toBe(1000);

    act(() => scroller.dispatchEvent(input()));
    scroller.scrollTop = 500;
    act(() => scroller.dispatchEvent(new Event('scroll', { bubbles: true })));
    for (let revision = 1; revision <= 3; revision++) {
      act(() => root.render(<Harness revision={revision} />));
      expect(scroller.scrollTop).toBe(500);
    }
    act(() => root.unmount());
  });

  it('continues a pending restore after asynchronous list growth when the user has not intervened', () => {
    window.sessionStorage.setItem('cat-cafe:sidebar:scrollTop', '1200');
    let top = 0;
    let maximum = 1000;
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(() => top);
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation((value) => {
      top = Math.max(0, Math.min(maximum, value));
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<Harness revision={0} />));
    const scroller = host.querySelector('[data-testid="scroller"]') as HTMLDivElement;
    expect(scroller.scrollTop).toBe(1000);
    maximum = 2000;
    act(() => root.render(<Harness revision={1} />));
    expect(scroller.scrollTop).toBe(1200);
    act(() => root.unmount());
  });
});
