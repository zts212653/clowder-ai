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
    getCatById: (id: string) =>
      id === 'codex-sol' ? { displayName: '缅因猫全名', nickname: '砚砚', variantLabel: 'GPT-6.1 Sol' } : undefined,
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

import { writeShellLanguage } from '@/components/shell/shell-language';
import { cancelProjectedExecution } from '@/hooks/useActiveExecutionProjection';
import { HomeWaitCard } from '../HomeWaitCard';
import { NOW, waitItem } from './home-fixtures';

describe('F322 new-shell Workspace home · 等待与接回', () => {
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
    writeShellLanguage('zh');
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
    writeShellLanguage('zh');
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not flash a known empty card during background projection polls', async () => {
    const { HomeWaitCard } = await import('../HomeWaitCard');
    mocks.projection = { projectPath: '/repo', items: [], candidate: null } as DeploymentWaitListResponse;
    for (const state of ['ready', 'loading', 'ready'] as const) {
      mocks.hydration = state;
      await act(async () => root.render(<HomeWaitCard hideWhenEmpty />));
      expect(container.querySelector('[data-testid="workspace-deployment-waits"]')).toBeNull();
    }
  });

  async function renderHome(): Promise<void> {
    await act(async () => root.render(<HomeWaitCard />));
  }

  const q = (selector: string) => container.querySelector<HTMLElement>(selector);
  const qa = (selector: string) => Array.from(container.querySelectorAll<HTMLElement>(selector));

  describe('等待与接回', () => {
    it('keeps the wait summary neutral, hides cat instructions until expanded, and explains the candidate count', async () => {
      mocks.hydration = 'ready';
      mocks.projection = {
        projectPath: '/project',
        candidate: { revision: '630c66bc19d2', observedAt: NOW, satisfiableCount: 2, unknownCount: 1 },
        items: [waitItem({ state: 'unknown', stateReason: 'deployment_evidence_incomplete' })],
      };
      await renderHome();
      const row = q('[data-testid="workspace-deployment-wait-item"]');
      expect(row?.querySelector('.home-wait-main')?.textContent).toContain('条件待确认');
      expect(row?.querySelector('[data-tone="warn"]')).toBeNull();
      const details = row?.querySelector<HTMLElement>('.home-wait-details');
      expect(details).not.toBeNull();
      expect(details?.hidden).toBe(true);
      expect(details?.textContent).toContain('请在原对话中完成验收');
      expect(q('[data-testid="deployment-candidate-preview"]')?.textContent).toContain(
        'main 上已有新版本，正式环境更新后这 2 件会接回',
      );
      act(() => writeShellLanguage('en'));
      expect(row?.querySelector('.home-wait-main')?.textContent).toContain('Condition unconfirmed');
      expect(row?.querySelector('button[aria-controls]')?.getAttribute('aria-label')).toBe('After resuming');
      act(() => row?.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
      expect(details?.hidden).toBe(false);
    });
    it('folds only confirmed update waits by default and persists the explicit choice', async () => {
      mocks.hydration = 'ready';
      mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => ({ collapsed: {} }) });
      mocks.projection = {
        projectPath: '/project',
        candidate: null,
        items: [
          waitItem({ taskId: 'update', taskTitle: '等更新的事', state: 'waiting_for_update' }),
          waitItem({ taskId: 'unknown', taskTitle: '证据未确认的事', state: 'unknown' }),
        ],
      };
      await renderHome();
      const fold = q('[data-testid="home-deployment-fold"]');
      expect(fold?.getAttribute('aria-expanded')).toBe('false');
      expect(fold?.textContent).toContain('1 件在等正式环境更新');
      expect(q('[data-state="unknown"]')?.closest('[hidden]')).toBeNull();
      expect(q('[data-state="waiting_for_update"]')?.closest('[hidden]')).not.toBeNull();
      expect(q('[data-testid="workspace-deployment-waits"]')?.classList.contains('home-card')).toBe(false);
      mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => ({ collapsed: { '/project': false } }) });
      await act(async () => fold?.click());
      expect(fold?.getAttribute('aria-expanded')).toBe('true');
      expect(mocks.apiFetch).toHaveBeenCalledWith(
        expect.stringContaining('section=deployment'),
        expect.objectContaining({ method: 'PUT' }),
      );
    });

    it('groups actual owning projects and uses the nameplate while keeping unknown waits outside the update fold', async () => {
      mocks.hydration = 'ready';
      mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => ({ collapsed: {} }) });
      mocks.projection = {
        scope: 'all',
        projectPath: null,
        candidate: null,
        items: [
          waitItem({ taskId: 'planet', projectPath: '/a/planet', state: 'unknown' }),
          waitItem({ taskId: 'cafe', projectPath: '/a/cafe', state: 'waiting_for_update' }),
        ],
      };
      useActiveExecutionStore.setState({ projectPath: '/a/planet' });
      await renderHome();
      expect(qa('[data-project-path]').map((node) => node.dataset.projectPath)).toEqual(['/a/planet', '/a/cafe']);
      const unknown = q('[data-state="unknown"]');
      expect(unknown?.textContent).toContain('砚砚 · GPT-6.1 Sol');
      expect(unknown?.textContent).not.toContain('缅因猫全名');
      expect(unknown?.closest('[hidden]')).toBeNull();
      expect(unknown?.querySelector('a')?.getAttribute('href')).toBe('/thread/thread-w');
      expect(unknown?.querySelector('.home-wait-details')?.hasAttribute('hidden')).toBe(true);
      expect(unknown?.querySelector('button')?.textContent).toBe('›');
      act(() => writeShellLanguage('en'));
      expect(q('[data-project-path="/a/planet"] .home-project-head')?.textContent).toContain('1 item');
      expect(q('[data-project-path="/a/planet"] .home-project-head')?.textContent).not.toContain('running');
    });

    it('uses one project disclosure for update-only work and preserves its choice when other waits join', async () => {
      mocks.hydration = 'ready';
      const preferences: Record<string, Record<string, boolean>> = { waiting: {}, deployment: {} };
      mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
        const section = new URL(path, 'http://test').searchParams.get('section') ?? 'waiting';
        if (init?.method === 'PUT') {
          const patch: { projectPath: string; collapsed: boolean } = JSON.parse(String(init.body));
          preferences[section][patch.projectPath] = patch.collapsed;
        }
        return Response.json({ collapsed: { ...preferences[section] } });
      });
      const updating = waitItem({ taskId: 'update', projectPath: '/a/cafe', state: 'waiting_for_update' });
      const otherProject = waitItem({ taskId: 'planet', projectPath: '/a/planet', state: 'unknown' });
      mocks.projection = { scope: 'all', projectPath: null, candidate: null, items: [updating, otherProject] };
      useActiveExecutionStore.setState({ projectPath: '/a/planet' });
      await renderHome();
      const cafe = q('[data-project-path="/a/cafe"]')!;
      const header = cafe.querySelector<HTMLButtonElement>('.home-project-head')!;
      expect(header.getAttribute('aria-expanded')).toBe('false');
      expect(header.textContent).toContain('1 件在等正式环境更新');
      expect(header.textContent).toContain('最久');
      expect(cafe.querySelector('.home-deployment-fold')).toBeNull();
      expect(cafe.querySelector('[data-state="waiting_for_update"]')?.closest('[hidden]')).not.toBeNull();
      await act(async () => header.click());
      expect(preferences.deployment['/a/cafe']).toBe(false);
      expect(preferences.waiting['/a/cafe']).toBeUndefined();
      expect(cafe.querySelector('[data-state="waiting_for_update"]')?.closest('[hidden]')).toBeNull();

      mocks.projection = {
        ...mocks.projection,
        items: [...mocks.projection.items, waitItem({ taskId: 'mixed', projectPath: '/a/cafe', state: 'unknown' })],
      };
      await renderHome();
      const mixed = q('[data-project-path="/a/cafe"]')!;
      expect(mixed.querySelector('[data-state="unknown"]')?.closest('[hidden]')).toBeNull();
      expect(mixed.querySelector('.home-deployment-fold')?.getAttribute('aria-expanded')).toBe('true');
      mocks.projection = { ...mocks.projection, items: [updating, otherProject] };
      await renderHome();
      expect(q('[data-project-path="/a/cafe"] .home-project-head')?.getAttribute('aria-expanded')).toBe('true');
      expect(q('[data-project-path="/a/cafe"] .home-deployment-fold')).toBeNull();
    });

    it('stays out of the way until the projection has been asked for', async () => {
      await renderHome();
      expect(q('[data-testid="workspace-deployment-waits"]')).toBeNull();
    });

    it('lists 可以接回 first, then 暂不能判定, then 等待更新, each with its own honest last line', async () => {
      mocks.hydration = 'ready';
      mocks.projection = {
        projectPath: '/project',
        candidate: null,
        items: [
          waitItem({ taskId: 'a-waiting', taskTitle: '等版本', state: 'waiting_for_update' }),
          waitItem({
            taskId: 'b-unknown',
            taskTitle: '证据不全',
            state: 'unknown',
            stateReason: 'deployment_evidence_incomplete',
          }),
          waitItem({
            taskId: 'c-ready',
            taskTitle: '可以收了',
            state: 'ready_to_return',
            matchedAt: NOW - 3_600_000,
            condition: { kind: 'new_ready_boot', services: ['api', 'web'] },
          }),
          waitItem({ taskId: 'd-bare-unknown', taskTitle: '没理由', state: 'unknown' }),
        ],
      };
      await renderHome();

      const rows = qa('[data-testid="workspace-deployment-wait-item"]');
      expect(rows.map((row) => row.querySelector('b')?.textContent)).toEqual([
        '可以收了',
        '证据不全',
        '没理由',
        '等版本',
      ]);
      expect(q('[data-testid="workspace-deployment-waits"]')?.textContent).toContain('所有对话 · 4 件');

      // ready: frozen at matchedAt (2h of the 3h elapsed), new boot wording, 可以继续
      expect(rows[0]?.textContent).toContain('2 小时');
      expect(rows[0]?.querySelector('.home-wait-details')?.textContent).toContain('已出现新启动，API + WEB 已就绪');
      expect(rows[0]?.textContent).toContain('可以继续：请在原对话中完成验收');
      // unknown with a reason: the reason, and the next step is still written
      expect(rows[1]?.textContent).toContain('条件待确认');
      expect(rows[1]?.textContent).toContain('接回后：请在原对话中完成验收');
      // unknown without one: the flat list has no heading, so the row says it itself
      expect(rows[2]?.textContent).toContain('暂时无法判定条件是否已满足');
      // waiting: version wording, no feature id on the screen
      expect(rows[3]?.textContent).toContain('等正式环境更新');
      expect(rows[3]?.querySelector('.home-wait-details')?.textContent).toContain(
        '等待运行版本包含 bbbbbbbb，API 就绪',
      );
      expect(container.textContent).not.toContain('F323');
      expect(rows.every((row) => row.querySelector('a')?.getAttribute('href') === '/thread/thread-w')).toBe(true);
    });

    it('says a condition is met only when the canonical state says so; otherwise it says what is being waited for', async () => {
      mocks.hydration = 'ready';
      mocks.projection = {
        projectPath: '/project',
        candidate: null,
        items: [
          waitItem({
            taskId: 'w1',
            taskTitle: '等版本',
            state: 'waiting_for_update',
            condition: { kind: 'revision_included', revision: 'bbbbbbbbcccccccc', services: ['api', 'web'] },
          }),
          waitItem({
            taskId: 'w2',
            taskTitle: '证据不全',
            state: 'unknown',
            stateReason: 'deployment_evidence_incomplete',
            condition: { kind: 'new_ready_boot', services: ['api'] },
          }),
          waitItem({
            taskId: 'w3',
            taskTitle: '可能就绪正在复核',
            state: 'waiting_for_update',
            stateReason: 'deployment_match_pending_recheck',
          }),
          waitItem({
            taskId: 'w4',
            taskTitle: '已就绪',
            state: 'ready_to_return',
            matchedAt: NOW - 60_000,
            condition: { kind: 'revision_included', revision: 'bbbbbbbbcccccccc', services: ['api', 'web'] },
          }),
        ],
      };
      await renderHome();
      const byTitle = (title: string) =>
        qa('[data-testid="workspace-deployment-wait-item"]').find(
          (row) => row.querySelector('b')?.textContent === title,
        )?.textContent ?? '';

      // not met: the target, services named, nothing in the past tense
      expect(byTitle('等版本')).toContain('等待运行版本包含 bbbbbbbb，API + WEB 就绪');
      expect(byTitle('证据不全')).toContain('等待新启动，API 就绪');
      expect(byTitle('可能就绪正在复核')).toContain('等待运行版本包含 bbbbbbbb，API 就绪');
      for (const title of ['等版本', '证据不全', '可能就绪正在复核']) {
        expect(byTitle(title)).not.toMatch(/已就绪|已包含|已出现/);
      }
      // met: the canonical ready state, in the past tense, with the same services
      expect(byTitle('已就绪')).toContain('运行版本已包含 bbbbbbbb，API + WEB 已就绪');
    });

    it('does not invent a wait time, an owner, or a next step', async () => {
      mocks.hydration = 'ready';
      mocks.projection = {
        projectPath: '/project',
        candidate: null,
        items: [waitItem({ createdAt: null, ownerCatId: null, nextStep: '' })],
      };
      await renderHome();
      const row = q('[data-testid="workspace-deployment-wait-item"]');
      expect(row?.textContent).toContain('等待时长未知');
      expect(row?.textContent).toContain('待确认负责猫');
      expect(row?.textContent).toContain('接回后：回原任务确认下一步');
    });

    it('explains an empty list and keeps the candidate preview as the card’s foot', async () => {
      mocks.hydration = 'ready';
      mocks.projection = {
        projectPath: '/project',
        items: [],
        candidate: { revision: '630c66bc19d2', observedAt: NOW - 4 * 60_000, satisfiableCount: 2, unknownCount: 1 },
      };
      await renderHome();
      const card = q('[data-testid="workspace-deployment-waits"]');
      expect(card?.textContent).toContain('暂无待跟进事项');
      expect(card?.textContent).toContain('猫会在原任务里登记');
      expect(card?.textContent).not.toContain('全局');
      expect(q('[data-testid="deployment-candidate-preview"]')?.textContent).toBe(
        'main 上已有新版本，正式环境更新后这 2 件会接回 · 另有 1 项证据待确认',
      );
    });

    it('offers 重试 when the list cannot be read, and keeps the last verified list when a refresh fails', async () => {
      mocks.hydration = 'error';
      mocks.projection = null;
      await renderHome();
      expect(q('[data-testid="workspace-deployment-waits"]')?.textContent).toContain('当前无法读取等待更新清单。');
      act(() => q('[data-testid="deployment-waits-retry"]')?.click());
      expect(mocks.retry).toHaveBeenCalledTimes(1);

      mocks.projection = { projectPath: '/project', items: [waitItem({})], candidate: null };
      await renderHome();
      expect(q('[data-testid="workspace-deployment-waits"]')?.textContent).toContain(
        '同步暂时失败，以上为最近一次已验证清单。',
      );
      expect(qa('[data-testid="workspace-deployment-wait-item"]')).toHaveLength(1);
      act(() => q('[data-testid="deployment-waits-retry"]')?.click());
      expect(mocks.retry).toHaveBeenCalledTimes(2);
    });
  });
});
