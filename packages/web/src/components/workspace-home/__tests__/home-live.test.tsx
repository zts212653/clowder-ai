import type { DeploymentWaitListResponse } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';

const mocks = vi.hoisted(() => ({
  catNames: new Map<string, { displayName: string; nickname?: string; variantLabel?: string }>(),
  projection: null as DeploymentWaitListResponse | null,
  hydration: 'ready' as 'idle' | 'loading' | 'ready' | 'error',
  retry: vi.fn(),
  apiFetch: vi.fn(),
  setWorkspaceMode: vi.fn(),
  openTeamSubject: vi.fn(),
}));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (id: string) => mocks.catNames.get(id) ?? (id === 'codex-sol' ? { displayName: '小太阳' } : undefined),
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
import { HomeLiveCard } from '../HomeLiveCard';
import { command, live, NOW, seed } from './home-fixtures';

describe('F322 new-shell Workspace home · 正在发生', () => {
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
    mocks.catNames.clear();
    mocks.projection = null;
    mocks.hydration = 'idle';
    mocks.retry.mockReset();
    mocks.apiFetch.mockReset();
    const storedFolds: Record<string, boolean> = {};
    mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/config/live-projects') {
        if (init?.method === 'PUT') {
          const { projectPath, collapsed } = JSON.parse(String(init.body));
          storedFolds[projectPath] = collapsed;
        }
        return Response.json({ collapsed: { ...storedFolds } });
      }
      return { ok: false };
    });
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

  async function renderHome(): Promise<void> {
    await act(async () => root.render(<HomeLiveCard threadId="thread-here" onSelectExecution={onSelectExecution} />));
  }

  const q = (selector: string) => container.querySelector<HTMLElement>(selector);
  const qa = (selector: string) => Array.from(container.querySelectorAll<HTMLElement>(selector));

  describe('正在发生', () => {
    it('keeps every project visible and folds only the selected project without losing exact work', async () => {
      seed([
        { ...live('codex-sol', 'thread-here', 'Current cafe work', 'cafe-1'), projectPath: '/work/cat-cafe' },
        { ...live('codex-sol', 'planet-a', 'F329 Tripo work', 'planet-1'), projectPath: '/work/cat-planet' },
        { ...live('opus', 'planet-b', 'F329 sandbox work', 'planet-2'), projectPath: '/work/cat-planet' },
      ]);
      await renderHome();
      const projects = qa('[data-testid="home-live-project"]');
      expect(projects).toHaveLength(2);
      const planet = projects.find((group) => group.textContent?.includes('cat-planet'))!;
      const toggle = planet.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(planet.querySelectorAll('[data-testid="workspace-running-object"]')).toHaveLength(2);
      await act(async () => toggle.click());
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(Object.keys(useActiveExecutionStore.getState().executionsByKey)).toHaveLength(3);
      expect(q('[data-execution-id="cafe-1"]')).not.toBeNull();
      await act(async () => root.render(null));
      await renderHome();
      const restoredPlanet = qa('[data-testid="home-live-project"]').find((group) =>
        group.textContent?.includes('cat-planet'),
      )!;
      const restoredToggle = restoredPlanet.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
      expect(restoredToggle.getAttribute('aria-expanded')).toBe('false');
      await act(async () => restoredToggle.click());
      expect(restoredPlanet.querySelector('[data-execution-id="planet-1"] a')?.getAttribute('href')).toBe(
        '/thread/planet-a',
      );
    });

    it('writes one row per cat and conversation and makes both current and other conversation text reachable', async () => {
      seed([live('codex-sol', 'thread-here', '改窄屏设计稿', 'e1'), live('opus', 'thread-other', 'F322 第1段', 'e2')]);
      await renderHome();

      expect(q('[data-testid="workspace-developing"] h2')?.textContent).toBe('正在发生');
      expect(q('[data-testid="workspace-developing"]')?.textContent).toContain('所有对话 · 2 件在跑');
      const rows = qa('[data-testid="workspace-running-object"]');
      expect(rows).toHaveLength(2);

      expect(rows[0]?.textContent).toContain('小太阳');
      expect(rows[0]?.textContent).toContain('当前对话');
      expect(rows[0]?.querySelector('.home-live-sub')?.textContent).toBe('当前对话 · 改窄屏设计稿');
      expect(rows[0]?.querySelector('.home-live-status')?.textContent).toBe('处理中');
      expect(rows[0]?.querySelector('button')?.disabled).toBe(false);

      expect(rows[1]?.textContent).toContain('opus');
      expect(rows[1]?.textContent).not.toContain('当前对话');
      const open = rows[1]?.querySelector('a');
      expect(open?.textContent).toContain('opus');
      expect(open?.textContent).toContain('F322 第1段');
      expect(open?.querySelector('button')).toBeNull();
      act(() => rows[1]?.querySelector<HTMLButtonElement>('[data-testid="home-execution-trajectory"]')?.click());
      expect(onSelectExecution).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-other', executionId: 'e2' }),
      );
    });

    it('keeps conversation navigation separate from the exact trajectory and Stop controls', async () => {
      const turn = live('codex-sol', 'thread-here', 'x', 'e1');
      seed([turn]);
      await renderHome();
      const row = q('[data-testid="workspace-open-running-object"]');
      expect(row?.tagName).toBe('A');
      act(() => q('[data-testid="home-execution-trajectory"]')?.click());
      expect(onSelectExecution).toHaveBeenCalledExactlyOnceWith(turn);
      expect(qa('button.home-stop')).toHaveLength(1);
      expect(qa('[data-testid="home-execution-trajectory"]')).toHaveLength(1);
      expect(cancelProjectedExecution).not.toHaveBeenCalled();
    });
    it('keeps a full nickname and adds models only for distinct cats sharing a nickname in this list', async () => {
      const name = { displayName: '缅因猫', nickname: '小太阳·砚砚', variantLabel: 'GPT-6.1 Sol' };
      mocks.catNames.set('codex-sol', name);
      seed(Array.from({ length: 20 }, (_, i) => live('codex-sol', 'thread-here', 'title', `e${i}`)));
      await renderHome();
      expect(qa('.home-live-name').map((node) => node.textContent)).toEqual(Array(20).fill('小太阳·砚砚'));
      mocks.catNames.set('other-sol', { ...name, variantLabel: 'GPT-6 Sol' });
      seed([live('codex-sol', 'thread-here', 'title', 'a'), live('other-sol', 'thread-here', 'title', 'b')]);
      await renderHome();
      expect(qa('.home-live-name').map((node) => node.textContent)).toEqual([
        '小太阳·砚砚 · GPT-6.1 Sol',
        '小太阳·砚砚 · GPT-6 Sol',
      ]);
    });

    it('lists every live run and background command separately with exact stop and ticking clocks', async () => {
      const turn = { ...live('codex-sol', 'thread-here', 'x', 'e1'), startedAt: NOW - 120_000 };
      const gate = command('codex-sol', 'thread-here', 'hold-1', 'full_gate', NOW - 50_000);
      seed([turn, gate]);
      await renderHome();

      expect(qa('[data-testid="workspace-running-object"]')).toHaveLength(2);
      const rows = qa('[data-testid="workspace-running-object"]');
      expect(rows[0]?.textContent).toContain('2:00');
      expect(rows[1]?.textContent).toContain('在跑全量门禁');
      expect(rows[1]?.textContent).toContain('0:50');
      expect(container.textContent).toContain('全量门禁');
      expect(qa('button.home-stop')).toHaveLength(2);

      await act(async () => {
        vi.advanceTimersByTime(2_000);
      });
      expect(qa('[data-testid="workspace-running-object"]')[1]?.textContent).toContain('0:52');
    });

    it('says what it cannot verify instead of staying silent', async () => {
      useActiveExecutionStore.getState().beginHydration('thread-here', '/project');
      await renderHome();
      expect(q('[data-testid="workspace-developing-status"]')?.textContent).toBe('正在同步所有对话的运行状态…');

      await act(async () => {
        useActiveExecutionStore.getState().reset();
        const store = useActiveExecutionStore.getState();
        store.failHydration('thread-here', store.beginHydration('thread-here', '/project'), new Error('offline'));
      });
      expect(q('[data-testid="workspace-developing-status"]')?.textContent).toBe('当前无法验证运行状态，请稍后重试。');
    });

    it('keeps the last verified rows and says the refresh failed', async () => {
      seed([live('codex-sol', 'thread-here', 'x', 'e1')]);
      const store = useActiveExecutionStore.getState();
      store.failHydration('thread-here', store.beginHydration('thread-here', '/project'), new Error('offline'));
      await renderHome();
      expect(qa('[data-testid="workspace-running-object"]')).toHaveLength(1);
      expect(q('[data-testid="workspace-developing"]')?.textContent).toContain(
        '同步暂时失败，以上为最近一次已验证状态。',
      );
    });

    it('keeps the section and one empty line when nothing is running', async () => {
      seed([]);
      await renderHome();
      expect(q('[data-testid="workspace-developing"]')).not.toBeNull();
      expect(q('[data-testid="workspace-developing-status"]')?.textContent).toBe('现在没有在跑的');
    });
  });
});
