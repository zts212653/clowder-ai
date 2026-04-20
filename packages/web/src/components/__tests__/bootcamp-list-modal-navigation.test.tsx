import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_THREAD_ROUTE_EVENT } from '../ThreadSidebar/thread-navigation';

const apiFetchMock = vi.hoisted(() => vi.fn());
const routerPushMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPushMock }),
}));

vi.mock('../../stores/chatStore', () => ({
  useChatStore: (selector: (state: { threads: unknown[]; setThreads: ReturnType<typeof vi.fn> }) => unknown) =>
    selector({ threads: [], setThreads: vi.fn() }),
}));

vi.mock('../../utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const { BootcampListModal } = await import('../BootcampListModal');

describe('BootcampListModal navigation', () => {
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

  it('uses the shared history bridge when opening an existing bootcamp thread', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        threads: [{ id: 'thread-bootcamp', title: '🎓 猫猫训练营', phase: 'phase-2-env-check' }],
      }),
    });
    const onClose = vi.fn();
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    await act(async () => {
      root.render(React.createElement(BootcampListModal, { open: true, onClose, currentThreadId: 'default' }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    const button = container.querySelector('[data-testid="bootcamp-item-thread-bootcamp"]');
    expect(button).toBeTruthy();

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(pushStateSpy).toHaveBeenCalledWith({}, '', '/thread/thread-bootcamp');
    expect(window.location.pathname).toBe('/thread/thread-bootcamp');
    expect(dispatchSpy.mock.calls.some(([event]) => event.type === CHAT_THREAD_ROUTE_EVENT)).toBe(true);
    expect(routerPushMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
