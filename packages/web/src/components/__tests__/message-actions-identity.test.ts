import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());
const getUserIdMock = vi.hoisted(() => vi.fn(() => 'alice'));
const confirmDialogSpy = vi.hoisted(() => vi.fn());
const pushMock = vi.fn();
const removeThreadMessageMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: { removeThreadMessage: typeof removeThreadMessageMock }) => unknown) =>
    selector({ removeThreadMessage: removeThreadMessageMock }),
}));

vi.mock('@/stores/toastStore', () => ({
  useToastStore: {
    getState: () => ({ addToast: vi.fn() }),
  },
}));

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
    removeThreadMessageMock.mockReset();
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
        // eslint-disable-next-line react/no-children-prop -- createElement in test
        React.createElement(MessageActions, {
          message: {
            id: 'msg-1',
            type: 'assistant',
            catId: 'codex',
            content: 'hello',
            timestamp: Date.now(),
          },
          threadId: 'thread-1',
          // biome-ignore lint/correctness/noChildrenProp: createElement in test
          children: React.createElement('div', null, 'assistant message'),
        }),
      );
    });

    const moreButton = container.querySelector('button[aria-label="更多消息操作"]') as HTMLButtonElement | null;
    expect(moreButton).not.toBeNull();
    await act(async () => {
      moreButton?.click();
    });
    const branchButton = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((button) =>
      button.textContent?.includes('从这里分支'),
    );
    expect(branchButton).toBeDefined();

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
  });

  it('settles an exact legacy review terminal through the operator-only typed endpoint', async () => {
    const { MessageActions } = await import('@/components/MessageActions');
    apiFetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          outcome: 'eligible',
          reviewerCatId: 'codex-terra',
          subjectRef: 'pr:owner/repo#4074',
          reviewedHeadSha: '6a907b316a907b316a907b316a907b316a907b31',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ outcome: 'committed', queueEntryId: 'queue-1' }),
      });

    await act(async () => {
      root.render(
        // eslint-disable-next-line react/no-children-prop -- createElement in test
        React.createElement(MessageActions, {
          message: {
            id: 'legacy-terminal-1',
            type: 'assistant',
            catId: 'codex-terra',
            content: 'Review 完成（旧消息没有 typed verdict）',
            timestamp: Date.now(),
            extra: {
              crossPost: { sourceThreadId: 'thread-reviewer' },
              coordination: {
                id: 'coord-review-1',
                phase: 'terminal',
                hop: 1,
                subjectRef: 'pr:owner/repo#4074',
              },
            },
          },
          threadId: 'thread-author',
          // biome-ignore lint/correctness/noChildrenProp: createElement in test
          children: React.createElement('div', null, 'review terminal'),
        }),
      );
    });

    const moreButton = container.querySelector('button[aria-label="更多消息操作"]') as HTMLButtonElement | null;
    await act(async () => {
      moreButton?.click();
    });
    const settleAction = document.querySelector<HTMLButtonElement>(
      '[data-testid="legacy-local-review-disposition-action"]',
    );
    expect(settleAction).not.toBeNull();

    await act(async () => {
      settleAction?.click();
    });
    expect(apiFetchMock).toHaveBeenNthCalledWith(1, '/api/messages/legacy-terminal-1/legacy-local-review-disposition', {
      method: 'GET',
    });
    expect(document.body.textContent).toContain('系统不会从正文猜 verdict');

    const changesRequested = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === '需要修改',
    );
    await act(async () => {
      changesRequested?.click();
    });

    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = apiFetchMock.mock.calls[1] as [string, { body?: string }];
    expect(url).toBe('/api/messages/legacy-terminal-1/legacy-local-review-disposition');
    const body = JSON.parse(init.body ?? '{}') as { decisionId?: string; verdict?: string };
    expect(body.verdict).toBe('changes_requested');
    expect(body.decisionId).toBeTypeOf('string');
    expect(body.decisionId).not.toHaveLength(0);
  });
});
