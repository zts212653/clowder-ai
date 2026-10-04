import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_TOOLTIP_DELAY_MS, AppTooltip, resetAppTooltipWarmState } from '../AppTooltip';

function pointer(el: Element, type: 'pointerover' | 'pointerout' | 'pointerdown' | 'pointerup', pointerType = 'mouse') {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  if (type === 'pointerout') Object.defineProperty(event, 'relatedTarget', { value: document.body });
  React.act(() => {
    el.dispatchEvent(event);
  });
}

function tip(): HTMLElement | null {
  return document.body.querySelector('[role="tooltip"]');
}

describe('F322 AppTooltip — the shell name tip', () => {
  let container: HTMLDivElement;
  let root: Root;

  function renderTwo(onClick = vi.fn()) {
    React.act(() => {
      root.render(
        <div>
          <AppTooltip label="小信箱" detail="暂无待办">
            <button type="button" aria-label="小信箱，暂无待办" data-testid="a" onClick={onClick}>
              a
            </button>
          </AppTooltip>
          <AppTooltip label="设置与管理">
            <button type="button" aria-label="设置与管理" data-testid="b">
              b
            </button>
          </AppTooltip>
        </div>,
      );
    });
    return {
      a: container.querySelector('[data-testid="a"]') as HTMLButtonElement,
      b: container.querySelector('[data-testid="b"]') as HTMLButtonElement,
    };
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    resetAppTooltipWarmState();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    React.act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('appears after ~150ms of pointer settle, not before, and never via a native title', () => {
    const { a } = renderTwo();
    expect(a.getAttribute('title')).toBeNull();
    pointer(a, 'pointerover');
    React.act(() => vi.advanceTimersByTime(APP_TOOLTIP_DELAY_MS - 1));
    expect(tip()).toBeNull();
    React.act(() => vi.advanceTimersByTime(1));
    expect(tip()?.textContent).toContain('小信箱');
    expect(tip()?.textContent).toContain('暂无待办');
    expect(a.getAttribute('title')).toBeNull();
  });

  it('moving to an adjacent control right after a tip closes does not wait again', () => {
    const { a, b } = renderTwo();
    pointer(a, 'pointerover');
    React.act(() => vi.advanceTimersByTime(APP_TOOLTIP_DELAY_MS));
    expect(tip()).not.toBeNull();
    pointer(a, 'pointerout');
    pointer(b, 'pointerover');
    // the neighbour's tip is immediate (no +150ms), and only one tip is ever visible
    React.act(() => vi.advanceTimersByTime(1));
    expect(document.body.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    expect(tip()?.textContent).toContain('设置与管理');
    expect(tip()?.textContent).not.toContain('小信箱');
  });

  it('keyboard focus shows immediately; click-focus from a mouse does not', () => {
    const { a, b } = renderTwo();
    const matches = vi.spyOn(Element.prototype, 'matches');
    matches.mockImplementation(function (this: Element, selector: string) {
      if (selector === ':focus-visible') return this === a;
      return false;
    });
    React.act(() => a.focus());
    expect(tip()?.textContent).toContain('小信箱');
    React.act(() => a.blur());
    expect(tip()).toBeNull();
    React.act(() => b.focus());
    expect(tip()).toBeNull();
  });

  it('Escape dismisses the tip and it stays away until the pointer leaves', () => {
    const { a } = renderTwo();
    pointer(a, 'pointerover');
    React.act(() => vi.advanceTimersByTime(APP_TOOLTIP_DELAY_MS));
    expect(tip()).not.toBeNull();
    React.act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(tip()).toBeNull();
    pointer(a, 'pointerover');
    React.act(() => vi.advanceTimersByTime(APP_TOOLTIP_DELAY_MS * 2));
    expect(tip()).toBeNull();
    pointer(a, 'pointerout');
    React.act(() => vi.advanceTimersByTime(200));
    pointer(a, 'pointerover');
    React.act(() => vi.advanceTimersByTime(APP_TOOLTIP_DELAY_MS));
    expect(tip()).not.toBeNull();
  });

  it('a mouse press on the control closes the tip (the user is acting on it)', () => {
    const { a } = renderTwo();
    pointer(a, 'pointerover');
    React.act(() => vi.advanceTimersByTime(APP_TOOLTIP_DELAY_MS));
    expect(tip()).not.toBeNull();
    pointer(a, 'pointerdown');
    expect(tip()).toBeNull();
  });

  it('touch: a long press shows the name and swallows the tap that follows; a short tap still acts', () => {
    const onClick = vi.fn();
    const { a } = renderTwo(onClick);
    pointer(a, 'pointerdown', 'touch');
    React.act(() => vi.advanceTimersByTime(460));
    expect(tip()?.textContent).toContain('小信箱');
    pointer(a, 'pointerup', 'touch');
    React.act(() => a.click());
    expect(onClick).not.toHaveBeenCalled();

    pointer(a, 'pointerdown', 'touch');
    pointer(a, 'pointerup', 'touch');
    React.act(() => a.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('adds no layout box (display: contents) so it cannot shift the rail', () => {
    renderTwo();
    const wrapper = container.querySelector('span') as HTMLSpanElement;
    expect(wrapper.style.display).toBe('contents');
  });
});
