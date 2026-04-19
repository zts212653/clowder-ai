import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InteractiveBlock } from '@/components/rich/InteractiveBlock';
import type { RichInteractiveBlock } from '@/stores/chat-types';
import { useGuideStore } from '@/stores/guideStore';

const apiFetchMock = vi.fn();
const mockUpdateRichBlock = vi.fn();
const mockStoreState = {
  currentThreadId: 'thread-1',
  updateRichBlock: mockUpdateRichBlock,
};

vi.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: () => mockStoreState },
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/utils/userId', () => ({
  getUserId: () => 'test-user',
}));

describe('InteractiveBlock direct callback actions', () => {
  let container: HTMLDivElement;
  let root: Root;
  const block: RichInteractiveBlock = {
    id: 'guide-offer',
    kind: 'interactive',
    v: 1,
    interactiveType: 'select',
    title: '开始引导吗？',
    options: [
      {
        id: 'start',
        label: '开始引导',
        action: {
          type: 'callback',
          endpoint: '/api/guide-actions/start',
          payload: { threadId: 'thread-1', guideId: 'add-member' },
        },
      },
    ],
  };

  beforeAll(() => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    apiFetchMock.mockReset();
    mockUpdateRichBlock.mockReset();
    mockStoreState.currentThreadId = 'thread-1';
    useGuideStore.setState({ session: null, completionPersisted: false, completionFailed: false, pendingStart: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useGuideStore.setState({ session: null, completionPersisted: false, completionFailed: false, pendingStart: null });
  });

  it('does not queue a local guide start when callback endpoint fails', async () => {
    apiFetchMock.mockResolvedValue({ ok: false, status: 500 });

    await act(async () => {
      root.render(React.createElement(InteractiveBlock, { block, messageId: 'message-1' }));
    });

    const optionBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('开始引导'));
    expect(optionBtn).toBeTruthy();
    await act(async () => {
      optionBtn!.click();
    });

    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('确认选择'),
    );
    expect(confirmBtn).toBeTruthy();
    await act(async () => {
      confirmBtn!.click();
      await Promise.resolve();
    });

    expect(apiFetchMock).toHaveBeenCalledWith('/api/guide-actions/start', expect.objectContaining({ method: 'POST' }));
    expect(useGuideStore.getState().pendingStart).toBeNull();
  });

  it('does not queue a local guide start after the active thread changes before start resolves', async () => {
    let resolveStart: ((value: { ok: boolean; status: number }) => void) | null = null;
    apiFetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve as (value: { ok: boolean; status: number }) => void;
        }),
    );

    await act(async () => {
      root.render(React.createElement(InteractiveBlock, { block, messageId: 'message-stale-thread' }));
    });

    const optionBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('开始引导'));
    expect(optionBtn).toBeTruthy();
    await act(async () => {
      optionBtn!.click();
    });

    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('确认选择'),
    );
    expect(confirmBtn).toBeTruthy();
    await act(async () => {
      confirmBtn!.click();
      await Promise.resolve();
    });

    mockStoreState.currentThreadId = 'thread-2';

    await act(async () => {
      resolveStart?.({ ok: true, status: 200 });
      await Promise.resolve();
    });

    expect(useGuideStore.getState().pendingStart).toBeNull();
  });

  it('rejects callback actions outside the safe guide-actions allowlist', async () => {
    const unsafeBlock: RichInteractiveBlock = {
      ...block,
      id: 'unsafe-guide-offer',
      options: [
        {
          id: 'unsafe-start',
          label: '危险操作',
          action: {
            type: 'callback',
            endpoint: '/api/admin/delete-all',
            payload: { threadId: 'thread-1', guideId: 'add-member' },
          },
        },
      ],
    };

    await act(async () => {
      root.render(React.createElement(InteractiveBlock, { block: unsafeBlock, messageId: 'message-2' }));
    });

    const optionBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('危险操作'));
    expect(optionBtn).toBeTruthy();
    await act(async () => {
      optionBtn!.click();
    });

    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('确认选择'),
    );
    expect(confirmBtn).toBeTruthy();
    await act(async () => {
      confirmBtn!.click();
      await Promise.resolve();
    });

    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(useGuideStore.getState().pendingStart).toBeNull();
  });

  it('rejects disallowed guide-actions callback endpoints even when they share the prefix', async () => {
    const disallowedGuideActionBlock: RichInteractiveBlock = {
      ...block,
      id: 'disallowed-guide-action',
      options: [
        {
          id: 'unsafe-complete',
          label: '直接完成',
          action: {
            type: 'callback',
            endpoint: '/api/guide-actions/complete',
            payload: { threadId: 'thread-1', guideId: 'add-member' },
          },
        },
      ],
    };

    await act(async () => {
      root.render(
        React.createElement(InteractiveBlock, { block: disallowedGuideActionBlock, messageId: 'message-2b' }),
      );
    });

    const optionBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('直接完成'));
    expect(optionBtn).toBeTruthy();
    await act(async () => {
      optionBtn!.click();
    });

    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('确认选择'),
    );
    expect(confirmBtn).toBeTruthy();
    await act(async () => {
      confirmBtn!.click();
      await Promise.resolve();
    });

    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(useGuideStore.getState().pendingStart).toBeNull();
  });

  it('keeps guide offer card interactive after preview selection', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, status: 200 });
    const previewableBlock: RichInteractiveBlock = {
      ...block,
      id: 'guide-offer-previewable',
      messageTemplate: '引导流程：{selection}',
      options: [
        { id: 'preview', label: '先看步骤概览' },
        {
          id: 'start',
          label: '开始引导',
          action: {
            type: 'callback',
            endpoint: '/api/guide-actions/start',
            payload: { threadId: 'thread-1', guideId: 'add-member' },
          },
        },
      ],
    };

    await act(async () => {
      root.render(React.createElement(InteractiveBlock, { block: previewableBlock, messageId: 'message-3' }));
    });

    const previewBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('先看步骤概览'),
    );
    expect(previewBtn).toBeTruthy();
    await act(async () => {
      previewBtn!.click();
    });

    let confirmBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('确认选择'));
    expect(confirmBtn).toBeTruthy();
    await act(async () => {
      confirmBtn!.click();
      await Promise.resolve();
    });

    const startBtnAfterPreview = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('开始引导'),
    ) as HTMLButtonElement | undefined;
    expect(startBtnAfterPreview).toBeTruthy();
    expect(startBtnAfterPreview?.disabled).toBe(false);
    expect(apiFetchMock.mock.calls.some(([url]) => url === '/api/guide-actions/start')).toBe(false);
    expect(useGuideStore.getState().pendingStart).toBeNull();

    await act(async () => {
      startBtnAfterPreview!.click();
    });

    confirmBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('确认选择'));
    expect(confirmBtn).toBeTruthy();
    await act(async () => {
      confirmBtn!.click();
      await Promise.resolve();
    });

    expect(apiFetchMock).toHaveBeenCalledWith('/api/guide-actions/start', expect.objectContaining({ method: 'POST' }));
    expect(useGuideStore.getState().pendingStart).toEqual({ guideId: 'add-member', threadId: 'thread-1' });
  });

  it('keeps ordinary non-callback interactive blocks one-shot', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, status: 200 });
    const oneShotBlock: RichInteractiveBlock = {
      id: 'one-shot-select',
      kind: 'interactive',
      v: 1,
      interactiveType: 'select',
      title: '选一个答案',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    };

    await act(async () => {
      root.render(React.createElement(InteractiveBlock, { block: oneShotBlock, messageId: 'message-4' }));
    });

    const optionBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('A'));
    expect(optionBtn).toBeTruthy();
    await act(async () => {
      optionBtn!.click();
    });

    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('确认选择'),
    );
    expect(confirmBtn).toBeTruthy();
    await act(async () => {
      confirmBtn!.click();
      await Promise.resolve();
    });

    const optionBtnsAfterSubmit = Array.from(container.querySelectorAll('button')).filter(
      (b) => b.textContent?.includes('A') || b.textContent?.includes('B'),
    ) as HTMLButtonElement[];
    expect(optionBtnsAfterSubmit).toHaveLength(2);
    expect(optionBtnsAfterSubmit.every((btn) => btn.disabled)).toBe(true);
  });
});
