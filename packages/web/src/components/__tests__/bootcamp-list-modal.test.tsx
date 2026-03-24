import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());
const pushMock = vi.hoisted(() => vi.fn());
const setThreadsMock = vi.hoisted(() => vi.fn());
const clearThreadStateMock = vi.hoisted(() => vi.fn());
const onCloseMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: apiFetchMock,
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (
    selector: (state: {
      threads: Array<{ id: string; title: string }>;
      setThreads: typeof setThreadsMock;
      clearThreadState: typeof clearThreadStateMock;
    }) => unknown,
  ) =>
    selector({
      threads: [{ id: 'existing-thread', title: 'Existing thread' }],
      setThreads: setThreadsMock,
      clearThreadState: clearThreadStateMock,
    }),
}));

describe('BootcampListModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    pushMock.mockReset();
    setThreadsMock.mockReset();
    clearThreadStateMock.mockReset();
    onCloseMock.mockReset();
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/bootcamp/threads') {
        return {
          ok: true,
          json: async () => ({ threads: [] }),
        };
      }
      if (path === '/api/threads') {
        return {
          ok: true,
          json: async () => ({ id: 'bootcamp-new', title: '🎓 猫猫训练营' }),
        };
      }
      return {
        ok: false,
        json: async () => ({}),
      };
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('clears stale cache before navigating to a newly created bootcamp thread', async () => {
    const { BootcampListModal } = await import('@/components/BootcampListModal');

    await act(async () => {
      root.render(React.createElement(BootcampListModal, { open: true, onClose: onCloseMock }));
    });

    const createButton = container.querySelector('[data-testid="bootcamp-list-create"]') as HTMLButtonElement | null;
    expect(createButton).not.toBeNull();

    await act(async () => {
      createButton?.click();
      await Promise.resolve();
    });

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/threads',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(setThreadsMock).toHaveBeenCalledWith([
      { id: 'bootcamp-new', title: '🎓 猫猫训练营' },
      { id: 'existing-thread', title: 'Existing thread' },
    ]);
    expect(clearThreadStateMock).toHaveBeenCalledWith('bootcamp-new');
    expect(pushMock).toHaveBeenCalledWith('/thread/bootcamp-new');
    expect(onCloseMock).toHaveBeenCalled();
  });
});
