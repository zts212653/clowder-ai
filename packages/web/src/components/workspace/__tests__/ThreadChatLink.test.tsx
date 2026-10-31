import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  closeRightPanel: vi.fn(),
}));

vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({
  getThreadHref: (threadId: string) => `/thread/${threadId}`,
  pushThreadRouteWithHistory: (...args: unknown[]) => mocks.push(...args),
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: () => ({ closeRightPanel: mocks.closeRightPanel }) },
}));

import { ThreadChatLink } from '../ThreadChatLink';

/** The link as it rendered before the new shell's home could restyle it. The classic home must keep drawing exactly this. */
const CLASSIC_CLASS_NAME =
  'shrink-0 rounded-lg border border-cafe-subtle px-2.5 py-1 text-micro font-semibold text-cafe-secondary transition-colors hover:bg-cafe-surface hover:text-cafe';

describe('ThreadChatLink', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('React', React);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.push.mockReset();
    mocks.closeRightPanel.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const link = () => container.querySelector('a') as HTMLAnchorElement;

  it('renders exactly the classic link when given only a thread', async () => {
    await act(async () => root.render(<ThreadChatLink threadId="t-1" />));
    expect(link().outerHTML).toBe(
      `<a href="/thread/t-1" class="${CLASSIC_CLASS_NAME}" title="前往这件工作的对话">Chat</a>`,
    );
  });

  it('lets the new shell choose the words and the look, nothing else', async () => {
    await act(async () =>
      root.render(<ThreadChatLink threadId="t-1" label="打开对话" className="home-btn" title="打开对话" />),
    );
    expect(link().outerHTML).toBe('<a href="/thread/t-1" class="home-btn" title="打开对话">打开对话</a>');
  });

  it('opens the conversation in place on a plain click, and leaves modified clicks to the browser', async () => {
    await act(async () => root.render(<ThreadChatLink threadId="t-1" />));

    const click = (init: MouseEventInit) => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
      act(() => {
        link().dispatchEvent(event);
      });
      return event;
    };

    expect(click({ metaKey: true }).defaultPrevented).toBe(false);
    expect(click({ button: 1 }).defaultPrevented).toBe(false);
    expect(mocks.push).not.toHaveBeenCalled();

    expect(click({}).defaultPrevented).toBe(true);
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith('t-1', window);
    expect(mocks.closeRightPanel).toHaveBeenCalledTimes(1);
  });
});
