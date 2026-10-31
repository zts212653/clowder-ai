import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageNavigator } from '../MessageNavigator';

vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined }) }));
vi.mock('@/hooks/useCoCreatorConfig', () => ({ useCoCreatorConfig: () => ({ name: 'Owner' }) }));
vi.mock('../shell/shell-presentation', () => ({ useShellPresentation: () => 'v2' }));

const messages = ['one', 'two', 'three'].map((id) => ({
  id,
  type: 'assistant' as const,
  catId: 'opus',
  content: id,
  timestamp: 1,
}));
const rect = (top: number, height: number): DOMRect => ({
  top,
  bottom: top + height,
  height,
  x: 0,
  y: top,
  left: 0,
  right: 400,
  width: 400,
  toJSON: () => ({}),
});

describe('piano forwards each real input to the existing reading owner', () => {
  let host: HTMLDivElement;
  let viewport: HTMLDivElement;
  let root: Root;
  const jump = vi.fn(() => true);
  const scrollTo = vi.fn(() => true);
  const end = vi.fn();
  const begin = vi.fn(() => ({ scrollTo, end }));

  function render(ownerKey = 'first') {
    act(() =>
      root.render(
        <MessageNavigator
          messages={messages}
          scrollContainerRef={{ current: viewport }}
          observerKey={ownerKey}
          onJumpToMessage={jump}
          beginUserScroll={begin}
        />,
      ),
    );
  }
  function required(selector: string): HTMLElement {
    const element = host.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    return element;
  }
  function pointer(type: string, y: number): MouseEvent {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: y });
    Object.defineProperty(event, 'pointerId', { value: 7 });
    return event;
  }

  beforeEach(() => {
    vi.stubGlobal('React', React);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    host = document.createElement('div');
    viewport = document.createElement('div');
    viewport.dataset.chatContainer = '';
    viewport.tabIndex = -1;
    viewport.getBoundingClientRect = () => rect(100, 300);
    Object.defineProperty(viewport, 'clientHeight', { value: 300 });
    Object.defineProperty(viewport, 'scrollHeight', { value: 1000 });
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return host.contains(this) ? rect(100, 300) : originalRect.call(this);
    });
    document.body.append(host, viewport);
    for (const [index, message] of messages.entries()) {
      const row = document.createElement('div');
      row.dataset.messageViewportId = message.id;
      row.dataset.messageViewportBoundary = '';
      row.textContent = message.content;
      row.getBoundingClientRect = () => rect(200 + index * 200 - viewport.scrollTop, 200);
      viewport.append(row);
    }
    root = createRoot(host);
    render();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    viewport.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('selects each keyboard row before Enter invokes the original jump port', () => {
    const track = required('[role="listbox"]');
    act(() => track.focus());
    const arrow = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    act(() => track.dispatchEvent(arrow));
    expect(arrow.defaultPrevented).toBe(true);
    expect(jump).not.toHaveBeenCalled();
    expect(track.getAttribute('aria-activedescendant')).toBe(required('[data-message-piano-key="two"]').id);
    act(() => track.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(jump).toHaveBeenCalledExactlyOnceWith('two');
    expect(begin).not.toHaveBeenCalled();
  });

  it('keeps native key clicks bound to that exact message', () => {
    act(() => required('[data-message-piano-key="two"]').click());
    expect(jump).toHaveBeenCalledExactlyOnceWith('two');
    expect(begin).not.toHaveBeenCalled();
  });

  it('delegates wheel pixels and PageDown to explicit user scrolling', () => {
    viewport.scrollTop = 100;
    const track = required('[role="listbox"]');
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 50 });
    act(() => track.dispatchEvent(wheel));
    expect(scrollTo).toHaveBeenLastCalledWith(150);
    expect(wheel.defaultPrevented).toBe(true);
    act(() => track.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true })));
    expect(scrollTo).toHaveBeenLastCalledWith(400);
    expect(end).toHaveBeenCalledTimes(2);
  });

  it('uses the same scale for a captured thumb drag and ends only its gesture', () => {
    const track = required('[role="listbox"]');
    track.setPointerCapture = vi.fn();
    act(() => required('[data-message-piano-grab]').dispatchEvent(pointer('pointerdown', 100)));
    act(() => track.dispatchEvent(pointer('pointermove', 160)));
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(200);
    act(() => track.dispatchEvent(pointer('pointerup', 160)));
    expect(end).toHaveBeenCalledOnce();
    act(() => track.click());
    expect(jump).not.toHaveBeenCalled();
  });

  it('routes the visible thumb itself to the original scroll gesture without jumping on release', () => {
    act(() => required('[data-message-piano-thumb]').dispatchEvent(pointer('pointerdown', 100)));
    expect(begin).toHaveBeenCalledOnce();
    act(() => required('[data-message-piano]').dispatchEvent(pointer('pointermove', 140)));
    expect(scrollTo).toHaveBeenCalled();
    act(() => required('[data-message-piano]').dispatchEvent(pointer('pointerup', 140)));
    act(() => required('[data-message-piano-thumb]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(end).toHaveBeenCalledOnce();
    expect(jump).not.toHaveBeenCalled();
  });

  it('cancels the captured gesture on an owner change and ignores its late pointer move', () => {
    act(() => required('[data-message-piano-grab]').dispatchEvent(pointer('pointerdown', 100)));
    render('second');
    expect(end).toHaveBeenCalledOnce();
    act(() => required('[role="listbox"]').dispatchEvent(pointer('pointermove', 200)));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('returns Escape focus to the conversation without writing a new position', () => {
    const track = required('[role="listbox"]');
    act(() => track.focus());
    act(() => track.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(viewport);
    expect(jump).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
  });
});
