/**
 * F109 Phase A — Toast error tests for all 4 MessageActions UI paths.
 *
 * Ensures `!res.ok` (business-logic 403/400) AND `catch` (network error)
 * both show a toast. This was the main silent-failure bug: fetch succeeds
 * but res.ok === false, never enters catch, no user feedback.
 *
 * Covers: confirmSoftDelete, confirmHardDelete, confirmBranch, confirmBranchDirect
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

describe('F109: MessageActions toast on errors (4 UI paths)', () => {
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

  // ── 2. Hard Delete ──

  describe('confirmHardDelete', () => {
    it('shows toast on !res.ok', async () => {
      // First call: GET thread info (for hard delete dialog setup)
      // Second call: DELETE (the actual hard delete)
      apiFetchMock
        .mockResolvedValueOnce({ ok: true, json: async () => ({ title: '测试对话' }) })
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          json: async () => ({ error: '确认标题不匹配' }),
        });
      renderActions(root);

      // Hard delete has a two-step flow: click button → GET thread → show dialog
      const btn = container.querySelector('button[title="永久删除"]') as HTMLButtonElement;
      expect(btn).not.toBeNull();
      await act(async () => {
        btn.click();
      });

      // Wait for the async handleHardDelete to resolve (GET thread)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });

      const dialog = findOpenDialog('永久删除');
      expect(dialog).toBeTruthy();
      await act(async () => {
        await dialog!.onConfirm?.();
      });

      expect(addToastMock).toHaveBeenCalledOnce();
      expect(addToastMock.mock.calls[0][0]).toMatchObject({ type: 'error', title: '删除失败' });
      expect(removeThreadMessageMock).not.toHaveBeenCalled();
    });

    it('shows toast on network error (catch path)', async () => {
      apiFetchMock
        .mockResolvedValueOnce({ ok: true, json: async () => ({ title: '测试对话' }) })
        .mockRejectedValueOnce(new Error('Network error'));
      renderActions(root);

      const btn = container.querySelector('button[title="永久删除"]') as HTMLButtonElement;
      await act(async () => {
        btn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });

      const dialog = findOpenDialog('永久删除');
      expect(dialog).toBeTruthy();
      await act(async () => {
        await dialog!.onConfirm?.();
      });

      expect(addToastMock).toHaveBeenCalledOnce();
      expect(addToastMock.mock.calls[0][0]).toMatchObject({ type: 'error', title: '删除失败' });
    });
  });

  // ── 3. Branch (from edit) ──

  describe('confirmBranch (edit → branch)', () => {
    it('shows toast on !res.ok', async () => {
      apiFetchMock.mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: '无权对此对话创建分支' }),
      });
      renderActions(root);

      // Edit button → opens textarea modal (not a ConfirmDialog)
      const editBtn = container.querySelector('button[title="编辑 (创建分支)"]') as HTMLButtonElement;
      expect(editBtn).not.toBeNull();
      await act(async () => {
        editBtn.click();
      });

      // Click the "保存" button inside the edit modal to trigger branch-confirm dialog
      const saveBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === '保存',
      ) as HTMLButtonElement | null;
      expect(saveBtn).not.toBeNull();
      await act(async () => {
        saveBtn!.click();
      });

      // Now the branch-confirm dialog should be open
      const dialog = findOpenDialog('创建分支');
      expect(dialog).toBeTruthy();
      await act(async () => {
        await dialog!.onConfirm?.();
      });

      expect(addToastMock).toHaveBeenCalledOnce();
      expect(addToastMock.mock.calls[0][0]).toMatchObject({ type: 'error', title: '分支创建失败' });
      expect(pushMock).not.toHaveBeenCalled();
    });

    it('shows toast on network error (catch path)', async () => {
      apiFetchMock.mockRejectedValue(new Error('Network error'));
      renderActions(root);

      const editBtn = container.querySelector('button[title="编辑 (创建分支)"]') as HTMLButtonElement;
      await act(async () => {
        editBtn.click();
      });
      const saveBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === '保存',
      ) as HTMLButtonElement;
      await act(async () => {
        saveBtn.click();
      });

      const dialog = findOpenDialog('创建分支');
      expect(dialog).toBeTruthy();
      await act(async () => {
        await dialog!.onConfirm?.();
      });

      expect(addToastMock).toHaveBeenCalledOnce();
      expect(addToastMock.mock.calls[0][0]).toMatchObject({ type: 'error', title: '分支创建失败' });
    });
  });

  // ── 4. Direct Branch ──

  describe('confirmBranchDirect', () => {
    it('shows toast on !res.ok', async () => {
      apiFetchMock.mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: '无权对此对话创建分支' }),
      });
      renderActions(root);
      await triggerAction(container, '从这里分支', '从这里分支');

      expect(addToastMock).toHaveBeenCalledOnce();
      expect(addToastMock.mock.calls[0][0]).toMatchObject({ type: 'error', title: '分支创建失败' });
      expect(pushMock).not.toHaveBeenCalled();
    });

    it('shows toast on network error (catch path)', async () => {
      apiFetchMock.mockRejectedValue(new Error('Network error'));
      renderActions(root);
      await triggerAction(container, '从这里分支', '从这里分支');

      expect(addToastMock).toHaveBeenCalledOnce();
      expect(addToastMock.mock.calls[0][0]).toMatchObject({ type: 'error', title: '分支创建失败' });
    });
  });
});
