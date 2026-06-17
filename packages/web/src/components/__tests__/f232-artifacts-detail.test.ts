/**
 * F232 Phase A.1 — ArtifactsPanel 内容查看交互 (AC-A7) + 列表项视觉 (AC-A5)。
 * 灵魂验收：点击产物行 → panel 内进入内容详情视图（不再只是外部 url「打开」）。
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockState } = vi.hoisted(() => ({
  mockState: { artifacts: [] as Array<Record<string, unknown>> },
}));

vi.mock('@/utils/api-client', () => ({ API_URL: 'http://test.local', apiFetch: vi.fn() }));
vi.mock('@/hooks/useThreadArtifacts', () => ({
  useThreadArtifacts: () => ({ artifacts: mockState.artifacts, loading: false, error: null }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (id: string) => (id === 'opus-48' ? { nickname: '宪宪' } : undefined),
  }),
}));

import { useChatStore } from '@/stores/chatStore';
import { ArtifactsPanel } from '../ArtifactsPanel';

function renderPanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(ArtifactsPanel, { threadId: 'T' }));
  });
  return { container, root };
}

describe('F232 AC-A7 ArtifactsPanel 内容查看交互', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    useChatStore.setState({ currentThreadId: 'T', workspaceWorktreeId: null });
    mockState.artifacts = [];
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('点击 PR 产物行 → 进入详情（GitHub 打开链接）；点返回 → 回列表', () => {
    mockState.artifacts = [
      {
        type: 'pr',
        name: 'PR #2247',
        catId: 'opus-48',
        createdAt: Date.now(),
        sourceMessageId: null,
        ref: 'zts212653/cat-cafe#2247',
      },
    ];
    const { container } = renderPanel();

    // 列表视图标志：搜索框存在
    expect(container.querySelector('input')).toBeTruthy();

    // 点击产物行（整行可点 = 灵魂入口）
    const row = container.querySelector('[data-artifact-row]') as HTMLElement | null;
    expect(row, '列表项应带 data-artifact-row 且整行可点').toBeTruthy();
    act(() => {
      row!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // 详情视图标志：返回按钮 + 指向该 PR 的 GitHub 链接
    const back = [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '返回');
    expect(back, '详情视图应有返回按钮').toBeTruthy();
    const gh = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href')?.includes('github.com'));
    expect(gh?.getAttribute('href')).toBe('https://github.com/zts212653/clowder-ai/pull/2247');

    // 返回 → 回列表
    act(() => {
      back!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('input'), '返回后回到列表（搜索框再现）').toBeTruthy();
  });

  it('AC-A5: 列表项显示猫昵称 + 相对时间（不是原始 catId）', () => {
    mockState.artifacts = [
      { type: 'pr', name: 'PR #1', catId: 'opus-48', createdAt: Date.now(), sourceMessageId: null, ref: 'o/r#1' },
    ];
    const { container } = renderPanel();
    expect(container.textContent).toContain('宪宪'); // 昵称映射
    expect(container.textContent).not.toContain('opus-48'); // 不显示原始 catId
    expect(container.textContent).toContain('刚刚'); // 相对时间
  });

  it('点击 image 产物行 → 详情显示图片', () => {
    mockState.artifacts = [
      {
        type: 'image',
        name: 'arch.png',
        catId: 'opus-48',
        createdAt: Date.now(),
        sourceMessageId: null,
        url: '/uploads/arch.png',
      },
    ];
    const { container } = renderPanel();
    const row = container.querySelector('[data-artifact-row]') as HTMLElement;
    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const img = container.querySelector('img');
    expect(img, 'image view 应渲染 <img>').toBeTruthy();
    expect(img?.getAttribute('src')).toContain('/uploads/arch.png');
  });

  it('P1-2: 切 thread 后清空选中详情（不串 thread）', () => {
    mockState.artifacts = [
      { type: 'pr', name: 'PR #A', catId: 'opus-48', createdAt: Date.now(), sourceMessageId: null, ref: 'o/r#1' },
    ];
    const { container, root } = renderPanel();
    // 打开详情
    const row = container.querySelector('[data-artifact-row]') as HTMLElement;
    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '返回'),
      '应在详情视图',
    ).toBeTruthy();
    // 切到 thread B（rerender 新 threadId，组件不 remount）
    act(() => {
      root.render(createElement(ArtifactsPanel, { threadId: 'T2' }));
    });
    expect(container.querySelector('input'), '切 thread 后应回列表（搜索框再现）').toBeTruthy();
    expect(
      [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '返回'),
      '切 thread 后不应残留旧 thread 详情',
    ).toBeFalsy();
  });
});
