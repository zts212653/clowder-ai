/**
 * F232 P2 (cloud review round 3): ArtifactsPanel「跳转」必须走 teleport（jump-with-load），
 * 而非裸 scrollToMessage。后端聚合全量产物后，老产物的 source message 常在已加载的 50 条
 * 窗口之外，裸 scrollToMessage 静默 no-op（AC-A4 失效）；planTeleport 在同 thread 也记录
 * pending teleport，让 useChatHistory 的 older-page resolver 自动加载更老历史再定位。
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetPendingTeleportForTest, peekPendingTeleport } from '@/utils/teleport';

vi.mock('@/utils/api-client', () => ({ API_URL: 'http://test.local' }));
vi.mock('@/utils/scrollToMessage', () => ({ scrollToMessage: vi.fn(() => false) }));
vi.mock('@/hooks/useThreadArtifacts', () => ({
  useThreadArtifacts: () => ({
    artifacts: [
      {
        type: 'file',
        name: 'old.pdf',
        url: '/uploads/old.pdf',
        catId: 'c',
        createdAt: 1,
        sourceMessageId: 'msg-old',
      },
    ],
    loading: false,
    error: null,
  }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: () => undefined }),
}));

import { useChatStore } from '@/stores/chatStore';
import { ArtifactsPanel } from '../ArtifactsPanel';

describe('F232 ArtifactsPanel jump (P2 cloud review round 3)', () => {
  let container: HTMLDivElement;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    __resetPendingTeleportForTest();
    useChatStore.setState({ currentThreadId: 'T' });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  it('clicking 跳转 records a pending teleport so an out-of-window source auto-loads (not a bare no-op scroll)', () => {
    const root = createRoot(container);
    act(() => {
      root.render(createElement(ArtifactsPanel, { threadId: 'T' }));
    });

    const jumpBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('跳转'));
    expect(jumpBtn, '跳转 button should render for an artifact with sourceMessageId').toBeTruthy();

    act(() => {
      jumpBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const pending = peekPendingTeleport('T');
    expect(pending, 'jump must record a pending teleport (jump-with-load), not bare scrollToMessage').not.toBeNull();
    expect(pending?.messageId).toBe('msg-old');
  });

  it('cross-thread jump navigates to /thread/<id> pathname, not /?threadId= query (Bug1 lobby fallback)', () => {
    // currentThread != panel thread → planTeleport returns navigateTo → must use pathname route.
    useChatStore.setState({ currentThreadId: 'other-thread' });
    window.history.replaceState(null, '', '/');
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    const root = createRoot(container);
    act(() => {
      root.render(createElement(ArtifactsPanel, { threadId: 'T' }));
    });

    const jumpBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('跳转'));
    expect(jumpBtn).toBeTruthy();
    act(() => {
      jumpBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(pushStateSpy).toHaveBeenCalledWith({}, '', '/thread/T');
  });
});
