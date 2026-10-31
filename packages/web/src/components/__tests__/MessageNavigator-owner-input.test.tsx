import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageNavigator } from '../MessageNavigator';

vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined }) }));
vi.mock('@/hooks/useCoCreatorConfig', () => ({ useCoCreatorConfig: () => ({ name: 'Owner' }) }));

const messages = ['one', 'two', 'three'].map((id) => ({
  id,
  type: 'assistant' as const,
  catId: 'opus',
  content: id,
  timestamp: 1,
}));

describe('MessageNavigator input ownership', () => {
  let host: HTMLDivElement;
  let root: Root;
  let scroll: HTMLDivElement;
  const jump = vi.fn(() => true);
  const scrollTo = vi.fn(() => true);
  const end = vi.fn();
  const beginUserScroll = vi.fn(() => ({ scrollTo, end }));
  beforeEach(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    scroll = document.createElement('div');
    document.body.append(host, scroll);
    Object.defineProperty(scroll, 'scrollHeight', { value: 1200 });
    Object.defineProperty(scroll, 'clientHeight', { value: 600 });
    root = createRoot(host);
    vi.clearAllMocks();
    act(() =>
      root.render(
        <MessageNavigator
          messages={messages}
          scrollContainerRef={{ current: scroll }}
          onJumpToMessage={jump}
          beginUserScroll={beginUserScroll}
        />,
      ),
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    scroll.remove();
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  it('routes a dot click through the reading owner instead of the global DOM helper', () => {
    const target = document.createElement('div');
    target.dataset.messageId = 'two';
    target.scrollIntoView = vi.fn();
    scroll.appendChild(target);
    act(() => host.querySelectorAll<HTMLButtonElement>('button')[1]!.click());
    expect(jump).toHaveBeenCalledExactlyOnceWith('two');
    expect(target.scrollIntoView).not.toHaveBeenCalled();
    expect(beginUserScroll).not.toHaveBeenCalled();
  });
  it('routes proportional track clicks through explicit user input', () => {
    const track = host.querySelector<HTMLElement>('.cursor-pointer')!;
    track.getBoundingClientRect = () => ({ top: 100, height: 200 }) as DOMRect;
    scroll.scrollTo = vi.fn();
    act(() => track.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 200 })));
    expect(beginUserScroll).toHaveBeenCalledOnce();
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(300);
    expect(scroll.scrollTo).not.toHaveBeenCalled();
  });
  it('forwards wheel input to the conversation and prevents page scrolling', () => {
    const track = host.querySelector<HTMLElement>('.cursor-pointer')!;
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -50 });
    scroll.scrollTop = 400;
    act(() => track.dispatchEvent(wheel));
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(350);
    expect(wheel.defaultPrevented).toBe(true);
  });
});
