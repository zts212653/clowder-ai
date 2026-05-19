import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_THREAD_ROUTE_EVENT } from '../ThreadSidebar/thread-navigation';

const apiFetchMock = vi.hoisted(() => vi.fn());
const routerPushMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPushMock }),
}));

vi.mock('../../utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const { HubListModal } = await import('../HubListModal');

describe('HubListModal navigation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    apiFetchMock.mockReset();
    routerPushMock.mockReset();
    window.history.replaceState({}, '', '/');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('switches threads via the shared history bridge so the chat layout sees the route change', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        threads: [{ id: 'thread-wecom', connectorId: 'wecom-bot', title: '企业微信群聊 · gNfR6Bag IM Hub' }],
      }),
    });
    const onClose = vi.fn();
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    await act(async () => {
      root.render(React.createElement(HubListModal, { open: true, onClose, currentThreadId: 'default' }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    const button = container.querySelector('[data-testid="hub-item-thread-wecom"]');
    expect(button).toBeTruthy();

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(pushStateSpy).toHaveBeenCalledWith({}, '', '/thread/thread-wecom');
    expect(window.location.pathname).toBe('/thread/thread-wecom');
    expect(dispatchSpy.mock.calls.some(([event]) => event.type === CHAT_THREAD_ROUTE_EVENT)).toBe(true);
    expect(routerPushMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
