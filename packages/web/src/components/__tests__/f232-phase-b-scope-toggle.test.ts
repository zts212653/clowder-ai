/**
 * F232 Phase B: scope toggle [当前对话] [全局] + global artifacts display.
 * Verifies AC-B1 (global search UI) and thread badge in global scope.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const THREAD_ARTIFACTS = [
  {
    type: 'image' as const,
    name: 'local.png',
    catId: 'opus',
    createdAt: 100,
    sourceMessageId: 'msg-1',
    url: '/uploads/local.png',
  },
];
const GLOBAL_ARTIFACTS = [
  {
    type: 'file' as const,
    name: 'readme.md',
    catId: 'codex',
    createdAt: 200,
    sourceMessageId: 'msg-2',
    threadId: 'T-other',
    threadTitle: 'F229 安全审计',
  },
  {
    type: 'image' as const,
    name: 'screenshot.png',
    catId: 'opus',
    createdAt: 150,
    sourceMessageId: 'msg-3',
    url: '/u/ss.png',
    threadId: 'T-current',
    threadTitle: 'F232 产物面板',
  },
];

vi.mock('@/utils/api-client', () => ({ API_URL: 'http://test.local' }));
vi.mock('@/utils/scrollToMessage', () => ({ scrollToMessage: vi.fn(() => false) }));
vi.mock('@/hooks/useThreadArtifacts', () => ({
  useThreadArtifacts: () => ({ artifacts: THREAD_ARTIFACTS, loading: false, error: null }),
}));
const mockGlobalRefetch = vi.fn();
vi.mock('@/hooks/useGlobalArtifacts', () => ({
  useGlobalArtifacts: (enabled: boolean) => ({
    artifacts: enabled ? GLOBAL_ARTIFACTS : [],
    loading: false,
    error: null,
    refetch: mockGlobalRefetch,
  }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (id: string) =>
      id === 'opus' ? { nickname: '宪宪' } : id === 'codex' ? { nickname: '砚砚' } : undefined,
  }),
}));

import { useChatStore } from '@/stores/chatStore';
import { ArtifactsPanel } from '../ArtifactsPanel';

describe('F232 Phase B scope toggle', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    useChatStore.setState({ currentThreadId: 'T-current', workspaceWorktreeId: 'main' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function render() {
    act(() => {
      root.render(createElement(ArtifactsPanel, { threadId: 'T-current' }));
    });
  }

  it('renders scope toggle with 当前对话 and 全局 buttons', () => {
    render();
    const buttons = container.querySelectorAll('button');
    const labels = Array.from(buttons).map((b) => b.textContent?.trim());
    expect(labels).toContain('当前对话');
    expect(labels).toContain('全局');
  });

  it('defaults to thread scope and shows thread artifacts', () => {
    render();
    expect(container.textContent).toContain('local.png');
    expect(container.textContent).not.toContain('readme.md');
  });

  it('switches to global scope when clicking 全局, shows global artifacts with thread badge', () => {
    render();
    const globalBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === '全局');
    expect(globalBtn).toBeTruthy();

    act(() => {
      globalBtn?.click();
    });

    // Global artifacts should now be visible
    expect(container.textContent).toContain('readme.md');
    expect(container.textContent).toContain('screenshot.png');
    // Thread badge should show
    expect(container.textContent).toContain('F229 安全审计');
    expect(container.textContent).toContain('F232 产物面板');
    // Thread-scoped artifact should NOT be visible
    expect(container.textContent).not.toContain('local.png');
  });

  it('updates search placeholder based on scope', () => {
    render();
    let input = container.querySelector('input') as HTMLInputElement;
    expect(input?.placeholder).toContain('本 thread');

    const globalBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === '全局');
    act(() => {
      globalBtn?.click();
    });

    input = container.querySelector('input') as HTMLInputElement;
    expect(input?.placeholder).toContain('所有对话');
  });

  it('P1 fix: cross-thread artifact detail passes null worktreeId to prevent wrong-file preview', () => {
    render();

    // Switch to global scope
    const globalBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === '全局');
    act(() => {
      globalBtn?.click();
    });

    // Click cross-thread artifact (readme.md from T-other, not T-current)
    const row = Array.from(container.querySelectorAll('[data-artifact-row]')).find((r) =>
      r.textContent?.includes('readme.md'),
    );
    expect(row).toBeTruthy();
    act(() => {
      (row as HTMLElement)?.click();
    });

    // The detail view should render (we see the artifact name in detail header)
    expect(container.textContent).toContain('readme.md');
    // The "返回" button should exist (we're in detail view)
    const backBtn = container.querySelector('button[aria-label="返回"]');
    expect(backBtn).toBeTruthy();
  });

  it('switches back to thread scope when clicking 当前对话', () => {
    render();

    // Go global first
    const globalBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === '全局');
    act(() => {
      globalBtn?.click();
    });
    expect(container.textContent).toContain('readme.md');

    // Switch back
    const threadBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '当前对话',
    );
    act(() => {
      threadBtn?.click();
    });
    expect(container.textContent).toContain('local.png');
    expect(container.textContent).not.toContain('readme.md');
  });
});
