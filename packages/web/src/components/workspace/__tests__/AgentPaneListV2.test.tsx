import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { WorkspaceSurfaceVisibilityProvider } from '@/components/workbench/WorkspaceSurfaceVisibility';
import { _resetCatDataCache } from '@/hooks/useCatData';
import { AgentPaneList } from '../AgentPaneList';

Object.assign(globalThis as Record<string, unknown>, { React });

const apiFetchMock = vi.fn();
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

const PANES = [
  { invocationId: 'inv-alpha-1', paneId: 'pane-1', status: 'running', startedAt: 1, catId: 'kimi' },
  { invocationId: 'inv-beta-22', paneId: 'pane-2', status: 'done', startedAt: 2, catId: 'kimi' },
  { invocationId: 'inv-unknown-3', paneId: 'pane-3', status: 'crashed', startedAt: 3, catId: null },
];

const CATS = {
  cats: [
    {
      id: 'kimi',
      displayName: '梵花猫',
      color: { primary: '#123456', secondary: '#abcdef' },
      mentionPatterns: [],
      carrier: 'cli',
      clientId: 'kimi-code',
      defaultModel: 'k3',
    },
  ],
};

describe('AgentPaneList v2', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    writeShellPresentation('v2');
    _resetCatDataCache();
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/terminal/agent-panes')) return Response.json(PANES);
      if (url.includes('/api/cats')) return Response.json(CATS);
      return new Response('not found', { status: 404 });
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    writeShellPresentation('classic');
    _resetCatDataCache();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(onSelectPane = vi.fn(), selectedPaneId?: string) {
    await act(async () => {
      root.render(
        <WorkspaceSurfaceVisibilityProvider visible={true}>
          <AgentPaneList worktreeId="worktree-a" onSelectPane={onSelectPane} selectedPaneId={selectedPaneId} />
        </WorkspaceSurfaceVisibilityProvider>,
      );
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    return onSelectPane;
  }

  it('shows a Chinese section header with pane count', async () => {
    await render();
    expect(container.textContent).toContain('猫的终端 3');
  });

  it('resolves pane identity from the server-provided catId, including done panes', async () => {
    await render();
    const rows = Array.from(container.querySelectorAll('button'));
    expect(rows[0]?.textContent).toContain('梵花猫');
    // 终态窗格同样保留身份（catId 在 spawn 时写入注册表，不随执行投影退出）
    expect(rows[1]?.textContent).toContain('梵花猫');
    expect(container.querySelector('img')).toBeTruthy();
  });

  it('falls back to the short invocation id when catId is absent', async () => {
    await render();
    const rows = Array.from(container.querySelectorAll('button'));
    expect(rows[2]?.textContent).toContain('inv-unknown-3'.slice(0, 8));
  });

  it('renders Chinese status labels', async () => {
    await render();
    expect(container.textContent).toContain('运行中');
    expect(container.textContent).toContain('已完成');
    expect(container.textContent).toContain('已崩溃');
  });

  it('passes pane identity meta to onSelectPane', async () => {
    const onSelectPane = await render();
    const firstRow = container.querySelector('button');
    expect(firstRow).toBeTruthy();
    await act(async () => {
      firstRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelectPane).toHaveBeenCalledWith(
      'pane-1',
      expect.objectContaining({ invocationId: 'inv-alpha-1', catId: 'kimi' }),
    );
  });

  // ROOT 2617 (coord-4df637af): 猫名在浅色 Workspace chrome 上用 --terminal-fg
  // （深色终端调色板的近白色）几乎不可读；选中行深色底 + 深色文字同样不可读。
  // 窗格列表在浅暗 chrome 上，身份文字/编号/选中态必须走主题语义 token。
  it('keeps pane identity legible on the workspace chrome via theme tokens, not the dark-terminal palette', async () => {
    await render(undefined, 'pane-1');
    const rows = Array.from(container.querySelectorAll('button'));
    expect(rows.length).toBe(3);

    const selected = rows[0] as HTMLButtonElement;
    // 猫名/回落编号：主题文字色，不是深色终端专用近白 --terminal-fg
    expect(selected.style.color).toBe('var(--cafe-text)');
    // 选中行底色：主题抬升色，深浅两态都能托住 --cafe-text，不是 --terminal-chrome
    expect(selected.style.background).toBe('var(--cafe-surface-sunken)');

    const unselected = rows[1] as HTMLButtonElement;
    expect(unselected.style.color).toBe('var(--cafe-text)');
    expect(unselected.style.background).toBe('transparent');

    // invocation 编号与状态标签：主题弱化文字色
    const idSpan = Array.from(selected.querySelectorAll('span')).find(
      (s) => s.textContent?.includes('inv-alph') && s.style.color !== '',
    ) as HTMLSpanElement | undefined;
    expect(idSpan?.style.color).toBe('var(--cafe-text-muted)');
    const statusSpan = selected.querySelector('span:last-child') as HTMLSpanElement;
    expect(statusSpan.style.color).toBe('var(--cafe-text-muted)');
  });
});
