import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerPopover } from '../ComposerPopover';

let root: Root;
let host: HTMLDivElement;
let trigger: HTMLButtonElement;
let rect: DOMRect;
const closed = vi.fn();

function Consumer({ presentation = 'anchor' }: { presentation?: 'anchor' | 'viewport' }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={anchor} type="button" onClick={() => setOpen(true)}>
        Add
      </button>
      <div data-testid="history">Conversation history</div>
      <button data-testid="outside" type="button">
        Outside
      </button>
      {open && (
        <ComposerPopover
          anchor={anchor}
          label="Composer control"
          presentation={presentation}
          onClose={() => {
            closed();
            setOpen(false);
          }}
        >
          <button type="button">First action</button>
          <div data-testid="panel-scroll">Scrollable menu</div>
        </ComposerPopover>
      )}
    </>
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  closed.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  rect = new DOMRect(24, 600, 40, 32);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function open(presentation: 'anchor' | 'viewport' = 'anchor') {
  await act(async () => root.render(<Consumer presentation={presentation} />));
  trigger = host.querySelector('button') as HTMLButtonElement;
  trigger.getBoundingClientRect = () => rect;
  Object.defineProperty(trigger, 'offsetWidth', { configurable: true, get: () => rect.width });
  Object.defineProperty(trigger, 'offsetHeight', { configurable: true, get: () => rect.height });
  act(() => trigger.click());
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
}
function scroll(target: EventTarget | null) {
  if (!target) throw new Error('Missing scroll target');
  act(() => target.dispatchEvent(new Event('scroll')));
}

describe('composer popover scroll and dismissal boundaries', () => {
  it.each(['anchor', 'viewport'] as const)('keeps %s open when only conversation history scrolls', async (mode) => {
    await open(mode);
    scroll(host.querySelector('[data-testid="history"]'));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(closed).not.toHaveBeenCalled();
  });

  it.each(['top', 'left', 'width', 'height'] as const)('dismisses when the anchor %s changes', async (coordinate) => {
    await open();
    const next = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
    next[coordinate] += 12;
    rect = new DOMRect(next.left, next.top, next.width, next.height);
    scroll(window);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('ignores the Add opening rotation when center and layout dimensions stay fixed', async () => {
    await open();
    Object.defineProperty(trigger, 'offsetWidth', { configurable: true, value: 40 });
    Object.defineProperty(trigger, 'offsetHeight', { configurable: true, value: 32 });
    rect = new DOMRect(20, 596, 48, 40);
    scroll(document);
    expect(closed).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('dismisses an anchor hidden in place', async () => {
    await open();
    trigger.style.visibility = 'hidden';
    scroll(document);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('dismisses if the trigger leaves the document during a scroll', async () => {
    await open();
    host.remove();
    try {
      scroll(window);
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      document.body.append(host);
    }
  });

  it('keeps panel scrolling open and leaves focus on the first action', async () => {
    await open();
    scroll(document.querySelector('[data-testid="panel-scroll"]'));
    expect(closed).not.toHaveBeenCalled();
    expect(document.activeElement?.textContent).toBe('First action');
  });

  it('closes on Escape and returns focus to the anchor', async () => {
    await open();
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on outside pointer without taking focus back', async () => {
    await open();
    const outside = host.querySelector('[data-testid="outside"]') as HTMLButtonElement;
    act(() => outside.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(trigger);
  });

  it('closes when focus moves outside the menu and anchor', async () => {
    await open();
    const outside = host.querySelector('[data-testid="outside"]') as HTMLButtonElement;
    act(() => outside.focus());
    expect(closed).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(outside);
  });

  it('retains anchor resize dismissal and focus return', async () => {
    await open();
    act(() => window.dispatchEvent(new Event('resize')));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps a viewport panel open on resize and recomputes its height', async () => {
    await open('viewport');
    vi.stubGlobal('innerHeight', 512);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect((document.querySelector('[role="dialog"]') as HTMLElement).style.height).toBe('480px');
    vi.unstubAllGlobals();
  });
});
