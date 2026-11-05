import type { DeploymentWaitListResponse } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';

const mocks = vi.hoisted(() => ({
  projection: null as DeploymentWaitListResponse | null,
  hydration: 'ready' as 'idle' | 'loading' | 'ready' | 'error',
  retry: vi.fn(),
  apiFetch: vi.fn(),
  setWorkspaceMode: vi.fn(),
  openTeamSubject: vi.fn(),
}));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (id: string) => (id === 'codex-sol' ? { displayName: '小太阳' } : undefined),
  }),
}));
vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: ({ catId }: { catId: string }) => <span data-testid="avatar" data-cat={catId} />,
}));
vi.mock('@/hooks/useActiveExecutionProjection', () => ({ cancelProjectedExecution: vi.fn() }));
vi.mock('@/hooks/useDeploymentWaitProjection', () => ({
  useDeploymentWaitProjection: () => ({
    projection: mocks.projection,
    hydration: mocks.hydration,
    error: null,
    retry: mocks.retry,
  }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mocks.apiFetch(...args) }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ setWorkspaceMode: mocks.setWorkspaceMode, openTeamSubject: mocks.openTeamSubject }),
}));
vi.mock('@/components/ChatVoiceFeatureControls', () => ({
  ChatVoiceFeatureControls: () => <div data-testid="voice-controls">语音控件</div>,
}));

import { cancelProjectedExecution } from '@/hooks/useActiveExecutionProjection';
import { WorkspaceToolsContent } from '../WorkspaceToolsContent';
import { NOW } from './home-fixtures';

describe('F322 new-shell Workspace home · 工具清单', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onSelectDestination = vi.fn();
  const onSelectDevSurface = vi.fn();
  const onSelectExecution = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('React', React);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    useActiveExecutionStore.getState().reset();
    mocks.projection = null;
    mocks.hydration = 'idle';
    mocks.retry.mockReset();
    mocks.apiFetch.mockReset();
    mocks.apiFetch.mockResolvedValue({ ok: false });
    mocks.setWorkspaceMode.mockReset();
    mocks.openTeamSubject.mockReset();
    onSelectDestination.mockReset();
    onSelectDevSurface.mockReset();
    onSelectExecution.mockReset();
    vi.mocked(cancelProjectedExecution).mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function renderHome(props: Partial<React.ComponentProps<typeof WorkspaceToolsContent>> = {}): Promise<void> {
    await act(async () =>
      root.render(
        <WorkspaceToolsContent
          worktreeId="wt-1"
          repository={{ name: 'cat-cafe', branch: 'feat/f322-workspace-home' }}
          onSelectDestination={onSelectDestination}
          onSelectDevSurface={onSelectDevSurface}
          onOpenSettings={vi.fn()}
          onClose={vi.fn()}
          onSelectRecentSurface={vi.fn()}
          recentSurfaces={[]}
          {...props}
        />,
      ),
    );
  }

  const q = (selector: string) => container.querySelector<HTMLElement>(selector);
  const qa = (selector: string) => Array.from(container.querySelectorAll<HTMLElement>(selector));

  describe('工具清单', () => {
    it('opens daily work tools directly from the default catalogue, without Settings or recent history', async () => {
      const onOpenSettings = vi.fn();
      await renderHome({ onOpenSettings, recentSurfaces: [] });
      for (const [kind, id] of [
        ['mode', 'schedule'],
        ['mode', 'eval'],
        ['mode', 'community'],
        ['workspace', 'capability-evolution'],
      ]) {
        const entry = q(`[data-workspace-destination="${kind}:${id}"]`);
        expect(entry, `default ${id} tool`).not.toBeNull();
        act(() => entry?.click());
        expect(onSelectDestination).toHaveBeenLastCalledWith(expect.objectContaining({ kind, id }));
      }
      expect(onOpenSettings).not.toHaveBeenCalled();
    });
    it('shows the tools in three groups with the one number or name each has', async () => {
      mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => ({ changedFiles: [{}, {}, {}], diff: '' }) });
      await renderHome();

      expect(qa('.home-group-title').map((node) => node.textContent)).toEqual(['活动', '代码', '其他']);
      expect(
        qa('.home-tool-grid [data-workspace-destination]').map((node) => node.dataset.workspaceDestination),
      ).toEqual([
        'host:status',
        'mode:trajectory',
        'action:theater',
        'mode:schedule',
        'mode:eval',
        'mode:tasks',
        'surface:files',
        'surface:changes',
        'surface:git',
        'surface:terminal',
        'surface:browser',
        'mode:recall',
        'host:voice',
        'host:films',
        'mode:team',
        'mode:community',
        'workspace:capability-evolution',
      ]);
      const meta = (id: string) => q(`[data-workspace-destination="${id}"] .home-tool-meta`)?.textContent;
      expect(meta('surface:files')).toBe('cat-cafe');
      expect(meta('surface:git')).toBe('feat/f322-workspace-home');
      expect(meta('surface:changes')).toBe('3 个文件');
      expect(meta('surface:terminal')).toBeUndefined();
      expect(mocks.apiFetch).toHaveBeenCalledWith('/api/workspace/diff?worktreeId=wt-1&view=files', expect.anything());
    });

    it('writes no number when it cannot read one, and none for zero changes', async () => {
      await renderHome();
      expect(q('[data-workspace-destination="surface:changes"] .home-tool-meta')).toBeNull();

      mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => ({ changedFiles: [], diff: '' }) });
      await renderHome({ worktreeId: 'wt-2' });
      expect(q('[data-workspace-destination="surface:changes"] .home-tool-meta')).toBeNull();

      mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => ({ unexpected: true }) });
      await renderHome({ worktreeId: 'wt-3' });
      expect(q('[data-workspace-destination="surface:changes"] .home-tool-meta')).toBeNull();
    });

    it('does not bring back an earlier worktree\u2019s count while its new read is unknown (A → B → A)', async () => {
      const changesMeta = () => q('[data-workspace-destination="surface:changes"] .home-tool-meta')?.textContent;
      mocks.apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ changedFiles: [{}, {}, {}], diff: '' }) });
      await renderHome({ worktreeId: 'wt-A' });
      expect(changesMeta()).toBe('3 个文件');

      mocks.apiFetch.mockRejectedValueOnce(new Error('offline'));
      await renderHome({ worktreeId: 'wt-B' });
      expect(changesMeta()).toBeUndefined();

      mocks.apiFetch.mockReturnValueOnce(new Promise(() => undefined));
      await renderHome({ worktreeId: 'wt-A' });
      expect(changesMeta()).toBeUndefined();
    });

    it('marks only the changed-file count as a count, so the narrow layout can keep number and unit whole under the name', async () => {
      mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => ({ changedFiles: [{}, {}, {}], diff: '' }) });
      await renderHome();
      const kindOf = (id: string) => q(`[data-workspace-destination="${id}"]`)?.getAttribute('data-meta-kind');
      expect(kindOf('surface:changes')).toBe('count');
      // the repository name and the branch are names, not counts: they keep the rules they had
      expect(kindOf('surface:files')).toBeNull();
      expect(kindOf('surface:git')).toBeNull();
      expect(kindOf('surface:terminal')).toBeNull();
    });

    it('marks nothing when the count is not known, because the row then says nothing', async () => {
      mocks.apiFetch.mockResolvedValue({ ok: false });
      await renderHome();
      expect(q('[data-workspace-destination="surface:changes"]')?.getAttribute('data-meta-kind')).toBeNull();
    });

    it('filters the rows as you type and says so when nothing matches', async () => {
      await renderHome();
      const search = q('[data-testid="workspace-launcher-search"]') as HTMLInputElement;
      expect(search.placeholder).toBe('搜索文件和工具…');
      expect(q('.home-signpost')?.textContent).toContain('审批和需要我处理在待办');

      const type = async (value: string) => {
        await act(async () => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          setter?.call(search, value);
          search.dispatchEvent(new Event('input', { bubbles: true }));
        });
      };
      await type('终端');
      expect(qa('[data-workspace-destination]').map((node) => node.dataset.workspaceDestination)).toEqual([
        'surface:terminal',
      ]);
      expect(qa('.home-group-title').map((node) => node.textContent)).toEqual(['代码']);
      expect(q('.home-signpost')).toBeNull();

      await type('zzz');
      expect(qa('[data-workspace-destination]')).toHaveLength(0);
      expect(q('.home-empty-search')?.textContent).toBe('没有找到匹配的内容');
    });

    it('keeps Schedule in the signpost and evolution in the searchable catalogue, using original destinations', async () => {
      await renderHome();
      const footer = q('.home-signpost');
      expect(footer?.textContent).toContain('可直接打开日程');
      expect(footer?.textContent).not.toContain('能力进化');
      // Schedule keeps its To-do signpost; evolution is a normal searchable tool.
      expect(q('.home-tool-grid [data-workspace-destination="mode:product-schedule"]')).toBeNull();
      expect(q('.home-tool-grid [data-workspace-destination="workspace:capability-evolution"]')).not.toBeNull();

      const allWork = q('[data-workspace-destination="mode:product-schedule"]');
      expect(allWork?.getAttribute('aria-label')).toBe('打开日程');
      act(() => allWork?.click());
      expect(onSelectDestination).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'mode', id: 'product-schedule' }),
      );
      const evolution = q('[data-workspace-destination="workspace:capability-evolution"]');
      expect(evolution?.textContent).toContain('能力进化');
      act(() => evolution?.click());
      expect(onSelectDestination).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'workspace', id: 'capability-evolution' }),
      );
      expect(onSelectDestination).toHaveBeenCalledTimes(2);
    });

    it('opens the original voice owner through the host', async () => {
      await renderHome();
      act(() => q('[data-workspace-destination="host:voice"]')?.click());
      expect(onSelectDestination).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ kind: 'host', id: 'voice' }),
      );
    });
  });
});
