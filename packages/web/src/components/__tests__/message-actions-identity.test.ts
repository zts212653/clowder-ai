import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());
const getUserIdMock = vi.hoisted(() => vi.fn(() => 'alice'));
const confirmDialogSpy = vi.hoisted(() => vi.fn());
const pushMock = vi.fn();
const removeMessageMock = vi.fn();
const clearThreadStateMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('@/stores/chatStore', () => {
  const state = {
    removeMessage: removeMessageMock,
    clearThreadState: clearThreadStateMock,
  };

  const useChatStore = (selector: (store: typeof state) => unknown) => selector(state);
  useChatStore.getState = () => state;

  return { useChatStore };
});

vi.mock('@/utils/api-client', () => ({
  apiFetch: apiFetchMock,
}));

vi.mock('@/utils/userId', () => ({
  getUserId: getUserIdMock,
}));

vi.mock('@/components/ConfirmDialog', () => ({
  ConfirmDialog: (props: unknown) => {
    confirmDialogSpy(props);
    return null;
  },
}));

describe('MessageActions identity source', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    pushMock.mockReset();
    removeMessageMock.mockReset();
    clearThreadStateMock.mockReset();
    window.history.pushState({}, '', '/?userId=alice');

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    apiFetchMock.mockReset();
    getUserIdMock.mockReset();
    getUserIdMock.mockReturnValue('alice');
    confirmDialogSpy.mockReset();
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ threadId: 'thread-branch-1' }),
    });
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root.unmount();
      });
    }
    if (container) {
      container.remove();
    }
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('uses current user identity instead of hardcoded default-user for direct branch', async () => {
    const { MessageActions } = await import('@/components/MessageActions');

    await act(async () => {
      root.render(
        React.createElement(
          MessageActions,
          {
            message: {
              id: 'msg-1',
              type: 'assistant',
              catId: 'codex',
              content: 'hello',
              timestamp: Date.now(),
            },
            threadId: 'thread-1',
          },
          React.createElement('div', null, 'assistant message'),
        ),
      );
    });

    const branchButton = container.querySelector('button[title="从这里分支"]') as HTMLButtonElement | null;
    expect(branchButton).not.toBeNull();

    await act(async () => {
      branchButton?.click();
    });

    const directDialogProps = confirmDialogSpy.mock.calls
      .map(([props]) => props as { title?: string; open?: boolean; onConfirm?: () => Promise<void> | void })
      .find((props) => props.title === '从这里分支' && props.open === true);

    expect(directDialogProps).toBeTruthy();
    expect(directDialogProps?.onConfirm).toBeTypeOf('function');

    await act(async () => {
      await directDialogProps?.onConfirm?.();
    });

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [, init] = apiFetchMock.mock.calls[0] as [string, { body?: string }];
    const body = JSON.parse(init.body ?? '{}') as { userId?: string };

    expect(body.userId).toBe('alice');
    expect(clearThreadStateMock).toHaveBeenCalledWith('thread-branch-1');
    expect(pushMock).toHaveBeenCalledWith('/thread/thread-branch-1');
  });

  it('clears stale cache before navigating from the edit-confirm branch flow', async () => {
    const { MessageActions } = await import('@/components/MessageActions');

    await act(async () => {
      root.render(
        React.createElement(
          MessageActions,
          {
            message: {
              id: 'msg-user-1',
              type: 'user',
              content: 'draft',
              timestamp: Date.now(),
            },
            threadId: 'thread-1',
          },
          React.createElement('div', null, 'user message'),
        ),
      );
    });

    const editButton = container.querySelector('button[title="编辑 (创建分支)"]') as HTMLButtonElement | null;
    expect(editButton).not.toBeNull();

    await act(async () => {
      editButton?.click();
    });

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const confirmDialogProps = confirmDialogSpy.mock.calls
      .map(([props]) => props as { title?: string; open?: boolean; onConfirm?: () => Promise<void> | void })
      .find((props) => props.title === '创建分支' && props.open === true);

    expect(confirmDialogProps).toBeTruthy();

    await act(async () => {
      await confirmDialogProps?.onConfirm?.();
    });

    expect(clearThreadStateMock).toHaveBeenCalledWith('thread-branch-1');
    expect(pushMock).toHaveBeenCalledWith('/thread/thread-branch-1');
  });
});
