/**
 * F109 Phase A — Toast error tests for MessageActions UI paths.
 *
 * Ensures `!res.ok` (business-logic 403/400) AND `catch` (network error)
 * both show a toast. This was the main silent-failure bug: fetch succeeds
 * but res.ok === false, never enters catch, no user feedback.
 *
 * Covers: confirmSoftDelete and the unified editable branch action.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());
const getUserIdMock = vi.hoisted(() => vi.fn(() => 'user-1'));
const addToastMock = vi.hoisted(() => vi.fn());
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
    getState: () => ({ addToast: addToastMock }),
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

const { MessageActions } = await import('@/components/MessageActions');

// ---------- helpers ----------

const userMessage = {
  id: 'msg-1',
  type: 'user' as const,
  catId: undefined as string | undefined,
  content: 'hello',
  timestamp: Date.now(),
};

function renderActions(root: Root, msg = userMessage) {
  act(() => {
    root.render(
      // eslint-disable-next-line react/no-children-prop -- createElement in test
      React.createElement(MessageActions, {
        message: msg,
        threadId: 'thread-1',
        // biome-ignore lint/correctness/noChildrenProp: createElement in test
        children: React.createElement('div', null, 'child'),
      }),
    );
  });
}

type DialogProps = {
  title?: string;
  open?: boolean;
  onConfirm?: () => Promise<void> | void;
};

/** Find the ConfirmDialog spy call whose title matches and is open */
function findOpenDialog(title: string): DialogProps | undefined {
  return confirmDialogSpy.mock.calls
    .map((args: unknown[]) => args[0] as DialogProps)
    .find((p: DialogProps) => p.title === title && p.open === true);
}

/** Click a toolbar button by its `title` attribute, then find + invoke the dialog */
async function triggerAction(container: HTMLDivElement, buttonTitle: string, dialogTitle: string) {
  const btn = container.querySelector(`button[title="${buttonTitle}"]`) as HTMLButtonElement | null;
  expect(btn, `button[title="${buttonTitle}"] should exist`).not.toBeNull();

  await act(async () => {
    btn!.click();
  });

  const dialog = findOpenDialog(dialogTitle);
  expect(dialog, `dialog "${dialogTitle}" should be open`).toBeTruthy();

  await act(async () => {
    await dialog!.onConfirm?.();
  });
}

// ---------- suite ----------

describe('F109: MessageActions toast on errors', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    pushMock.mockReset();
    removeThreadMessageMock.mockReset();
    apiFetchMock.mockReset();
    addToastMock.mockReset();
    getUserIdMock.mockReset();
    getUserIdMock.mockReturnValue('user-1');
    confirmDialogSpy.mockReset();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  // ── 1. Soft Delete ──

  describe('confirmSoftDelete', () => {
    it('shows toast on !res.ok (e.g. 403)', async () => {
      apiFetchMock.mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: '无权删除' }),
      });
      renderActions(root);
      await triggerAction(container, '删除', '删除消息');

      expect(addToastMock).toHaveBeenCalledOnce();
      expect(addToastMock.mock.calls[0][0]).toMatchObject({ type: 'error', title: '删除失败' });
      expect(removeThreadMessageMock).not.toHaveBeenCalled();
    });

    it('shows toast on network error (catch path)', async () => {
      apiFetchMock.mockRejectedValue(new Error('Network error'));
      renderActions(root);
      await triggerAction(container, '删除', '删除消息');

      expect(addToastMock).toHaveBeenCalledOnce();
      expect(addToastMock.mock.calls[0][0]).toMatchObject({ type: 'error', title: '删除失败' });
    });
  });

  // ── 2. Unified editable branch ──

  describe('confirmBranch', () => {
    async function triggerBranch(container: HTMLDivElement) {
      const branchButtons = container.querySelectorAll('button[aria-label="创建分支"]');
      expect(branchButtons).toHaveLength(1);
      expect(container.querySelector('button[aria-label="编辑并创建分支"]')).toBeNull();
      expect(container.querySelector('button[aria-label="撤回并重新编辑"]')).toBeNull();
      await act(async () => (branchButtons[0] as HTMLButtonElement).click());
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null;
      expect(textarea?.value).toBe('hello');
      const createButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === '创建分支',
      ) as HTMLButtonElement | undefined;
      expect(createButton).toBeTruthy();
      await act(async () => createButton?.click());
    }

    it('shows toast on !res.ok', async () => {
      apiFetchMock.mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: '无权对此对话创建分支' }),
      });
      renderActions(root);
      await triggerBranch(container);

      expect(addToastMock).toHaveBeenCalledOnce();
      expect(addToastMock.mock.calls[0][0]).toMatchObject({ type: 'error', title: '分支创建失败' });
      expect(pushMock).not.toHaveBeenCalled();
      expect(apiFetchMock).toHaveBeenCalledWith('/api/threads/thread-1/branch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromMessageId: 'msg-1', editedContent: undefined, userId: 'user-1' }),
      });
    });

    it('shows toast on network error (catch path)', async () => {
      apiFetchMock.mockRejectedValue(new Error('Network error'));
      renderActions(root);
      await triggerBranch(container);

      expect(addToastMock).toHaveBeenCalledOnce();
      expect(addToastMock.mock.calls[0][0]).toMatchObject({ type: 'error', title: '分支创建失败' });
    });
  });
});
