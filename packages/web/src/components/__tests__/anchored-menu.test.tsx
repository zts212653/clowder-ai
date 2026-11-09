import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnchoredMenu } from '../useAnchoredMenu';

function Menu() {
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);
  const menu = useAnchoredMenu(open, anchor, panel, () => setOpen(false));
  return (
    <>
      <div data-testid="sidebar-thread-list">
        <button ref={anchor} type="button" aria-expanded={open}>
          More
        </button>
        {open && (
          <div ref={panel} role="menu" onKeyDown={menu.onKeyDown}>
            <button type="button" role="menuitem">
              Rename
            </button>
          </div>
        )}
      </div>
      <main />
    </>
  );
}

describe('anchored menu scroll dismissal', () => {
  let host: HTMLDivElement;
  let root: Root;
  let anchorShift: number;
  function scroll(selector: string) {
    const element = host.querySelector(selector);
    if (!element) throw new Error(`Missing scroll container: ${selector}`);
    act(() => element.dispatchEvent(new Event('scroll')));
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    anchorShift = 0;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return this.matches('button[aria-expanded]')
        ? new DOMRect(100, 100 + anchorShift, 20, 20)
        : new DOMRect(0, 0, 144, 180);
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Menu />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('keeps the menu open when layout compensation scrolls an ancestor without moving its trigger', () => {
    scroll('[data-testid="sidebar-thread-list"]');
    expect(host.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.activeElement?.textContent).toBe('Rename');
  });

  it('dismisses and restores focus when ancestor scrolling moves its trigger', () => {
    anchorShift = -20;
    scroll('[data-testid="sidebar-thread-list"]');
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement?.textContent).toBe('More');
  });

  it('ignores scrolling outside its ancestor chain', () => {
    scroll('main');
    expect(host.querySelector('[role="menu"]')).not.toBeNull();
  });
});
