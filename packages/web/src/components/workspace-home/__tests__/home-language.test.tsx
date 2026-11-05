import type { DeploymentWaitListResponse } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import type { LauncherWorkspaceSearch } from '@/components/workspace/WorkspaceLauncherSearch';
import type { SearchResult } from '@/hooks/useWorkspace';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';

const mocks = vi.hoisted(() => ({
  projection: null as DeploymentWaitListResponse | null,
  hydration: 'ready' as 'idle' | 'loading' | 'ready' | 'error',
  apiFetch: vi.fn(),
}));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (id: string) => (id === 'codex-sol' ? { displayName: 'Sol' } : undefined),
  }),
}));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => null }));
vi.mock('@/hooks/useActiveExecutionProjection', () => ({ cancelProjectedExecution: vi.fn() }));
vi.mock('@/hooks/useDeploymentWaitProjection', () => ({
  useDeploymentWaitProjection: () => ({
    projection: mocks.projection,
    hydration: mocks.hydration,
    error: null,
    retry: vi.fn(),
  }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mocks.apiFetch(...args) }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ setWorkspaceMode: vi.fn(), openTeamSubject: vi.fn() }),
}));
vi.mock('@/components/ChatVoiceFeatureControls', () => ({ ChatVoiceFeatureControls: () => null }));

import { WorkspaceLauncherSearch } from '@/components/workspace/WorkspaceLauncherSearch';
import { HomeLiveCard } from '../HomeLiveCard';
import { HomeWaitCard } from '../HomeWaitCard';
import { WorkspaceHomeV2 } from '../WorkspaceHomeV2';
import { WorkspaceToolsContent } from '../WorkspaceToolsContent';

import { homeCopy } from '../workspace-home.shell-copy';
import { command, live, NOW, seed, waitItem } from './home-fixtures';

/** Chinese letters, CJK punctuation and fullwidth forms: nothing the page spells itself may contain these in English. */
const CJK = /[　-〿㐀-䶿一-鿿＀-￯]/u;

function results(count: number): SearchResult[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `src/file-${index}.ts`,
    line: index + 1,
    content: 'const x = 1;',
    contextBefore: '',
    contextAfter: '',
    matchType: index % 2 === 0 ? ('filename' as const) : ('content' as const),
  }));
}

function searchOf(over: Partial<LauncherWorkspaceSearch>): LauncherWorkspaceSearch {
  return {
    enabled: true,
    results: [],
    loading: false,
    error: null,
    onSearch: vi.fn(),
    onReset: vi.fn(),
    onOpenResult: vi.fn(),
    onViewAll: vi.fn(),
    ...over,
  };
}

describe('F322 AC-B6–B8 · the Workspace home speaks the chosen language', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('React', React);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    window.localStorage.clear();
    useActiveExecutionStore.getState().reset();
    mocks.projection = null;
    mocks.hydration = 'idle';
    mocks.apiFetch.mockReset();
    mocks.apiFetch.mockResolvedValue({ ok: false });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function renderHome(props: Partial<React.ComponentProps<typeof WorkspaceHomeV2>> = {}) {
    await act(async () => {
      root.render(
        <>
          <HomeLiveCard threadId="thread-here" onSelectExecution={vi.fn()} />
          <HomeWaitCard />
          <WorkspaceToolsContent
            worktreeId="wt-1"
            onOpenSettings={vi.fn()}
            onClose={vi.fn()}
            onSelectRecentSurface={vi.fn()}
            recentSurfaces={[]}
            onSelectDevSurface={vi.fn()}
            repository={{ name: 'cat-cafe', branch: 'feat/f322-home' }}
            onSelectDestination={vi.fn()}
            workspaceSearch={props.workspaceSearch}
            initialSearchQuery={props.workspaceSearchQuery}
          />
        </>,
      );
    });
  }

  const q = (selector: string) => container.querySelector<HTMLElement>(selector);
  const qa = (selector: string) => Array.from(container.querySelectorAll<HTMLElement>(selector));
  const text = () => container.textContent ?? '';

  async function setLanguage(language: 'zh' | 'en') {
    await act(async () => writeShellLanguage(language));
  }

  /** The search box waits 250ms before it asks; its timer is a real one in these tests. */
  async function waitForSearchDebounce() {
    await act(async () => {
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 320));
    });
  }

  async function type(value: string) {
    const search = q('[data-testid="workspace-launcher-search"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, value);
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function fillTheWholePage() {
    seed([
      live('codex-sol', 'thread-here', 'Alpha thread', 'e1'),
      command('codex-sol', 'thread-here', 'c1', 'full_gate', NOW - 50_000),
      command('codex-sol', 'thread-other', 'c2', 'lint', NOW - 90_000),
    ]);
    mocks.hydration = 'ready';
    mocks.projection = {
      projectPath: '/project',
      candidate: { revision: '630c66bc19d2', observedAt: NOW - 4 * 60_000, satisfiableCount: 2, unknownCount: 1 },
      items: [
        waitItem({
          taskId: 'w1',
          taskTitle: 'Wait for the version',
          nextStep: 'Verify it in the original conversation',
          state: 'waiting_for_update',
          condition: { kind: 'revision_included', revision: 'bbbbbbbbcccccccc', services: ['api', 'web'] },
        }),
        waitItem({
          taskId: 'w2',
          taskTitle: 'Evidence is thin',
          nextStep: 'Verify it in the original conversation',
          state: 'unknown',
          stateReason: 'deployment_evidence_incomplete',
          condition: { kind: 'new_ready_boot', services: ['api'] },
        }),
        waitItem({
          taskId: 'w3',
          taskTitle: 'Ready to collect',
          nextStep: 'Verify it in the original conversation',
          state: 'ready_to_return',
          matchedAt: NOW - 3_600_000,
          condition: { kind: 'revision_included', revision: 'dddddddd11111111', services: ['api'] },
        }),
        waitItem({
          taskId: 'w4',
          taskTitle: 'Nobody knows',
          nextStep: '',
          ownerCatId: null,
          state: 'unknown',
          createdAt: null,
        }),
      ],
    };
  }

  describe('English', () => {
    beforeEach(async () => {
      await setLanguage('en');
    });

    it('speaks only English across the whole page (what people and cats typed is data, and the fixture has none in Chinese)', async () => {
      mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => ({ changedFiles: [{}, {}, {}], diff: '' }) });
      fillTheWholePage();
      await renderHome();

      expect(text()).not.toMatch(CJK);
      expect(q('[data-testid="workspace-launcher-search"]')?.getAttribute('placeholder')).toBe(
        'Search files and tools…',
      );
      expect(q('[data-testid="workspace-launcher-search"]')?.getAttribute('placeholder')).not.toMatch(CJK);
      for (const node of qa('[aria-label], [title]')) {
        expect(`${node.getAttribute('aria-label') ?? ''}${node.getAttribute('title') ?? ''}`).not.toMatch(CJK);
      }
      expect(q('#home-live-title')?.textContent).toBe('Happening now');
      expect(q('#home-wait-title')?.textContent).toBe('Waiting to resume');
      expect(qa('.home-group-title').map((node) => node.textContent)).toEqual(['Activity', 'Code', 'Other']);
      expect(q('.home-signpost')?.textContent).toContain('approvals and items needing you are in To-do');
      expect(q('.home-signpost')?.textContent).toContain('Open Schedule');
      expect(q('[data-workspace-destination="workspace:capability-evolution"]')?.textContent).toContain(
        'Capability evolution',
      );
      expect(q('[data-workspace-destination="surface:changes"]')?.textContent).toContain('3 files');
    });

    it('says each wait condition as one English sentence, in the tense the canonical state allows', async () => {
      fillTheWholePage();
      await renderHome();
      const rows = qa('[data-testid="workspace-deployment-wait-item"]').map((row) => row.textContent ?? '');
      // ready first, then unknown, then waiting — the order is the state's, not the language's
      expect(rows[0]).toContain('2 hours');
      expect(rows[0]).toContain('Running version includes dddddddd; API ready');
      expect(rows[0]).toContain('Ready to resume: Verify it in the original conversation');
      expect(rows[1]).toContain("Haven't confirmed the live environment meets this condition");
      expect(rows[1]).toContain('Waiting for a restart and API to be ready');
      expect(rows[2]).toContain('Wait time unknown');
      expect(rows[2]).toContain("Can't tell yet whether the condition is met");
      expect(rows[2]).toContain('After resuming: Confirm the next step in the original task');
      expect(rows[3]).toContain('Waiting for live update');
      expect(rows[3]).toContain('Waiting until the running version includes bbbbbbbb and API + WEB are ready');
      expect(q('#home-wait-title')?.parentElement?.textContent).toContain('All conversations · 4 items');
      expect(q('[data-testid="deployment-candidate-preview"]')?.textContent).toBe(
        'A newer version is on main; after the live update, 2 items will resume · 1 more item to confirm',
      );
    });

    it('names background work and the live rows in English', async () => {
      fillTheWholePage();
      await renderHome();
      const live = text();
      expect(live).toContain('All conversations · 3 running');
      expect(live).toContain('Current conversation');
      expect(live).toContain('Running full gate');
      expect(live).toContain('0:50');
      // An invocation without an activity proof uses the existing neutral conversation label.
      expect(live).toContain('Working');
      expect(live).toContain('Running code checks');
      expect(
        qa('[data-testid="home-execution-trajectory"]').every((node) =>
          node.getAttribute('aria-label')?.includes('trajectory'),
        ),
      ).toBe(true);
    });

    it('words the condition so it agrees with one service or several', () => {
      const { wait } = homeCopy.en;
      expect(wait.awaitingRevision('aaaaaaaa', 'API')).toBe(
        'Waiting until the running version includes aaaaaaaa and the API is ready',
      );
      // several services: no article before a list, and "are" (the single-service sentence keeps the table's wording)
      expect(wait.awaitingRevision('aaaaaaaa', 'API + WEB')).toBe(
        'Waiting until the running version includes aaaaaaaa and API + WEB are ready',
      );
    });

    it('uses the F323 owner ruling for the six domain wordings, with the services, time and count left as parameters (1463)', () => {
      // Pinned on purpose: these are the owner's words (naming table §一·b); changing one is a deliberate step made here.
      const { wait } = homeCopy.en;
      expect(wait.awaitingNewBoot('API')).toBe('Waiting for a restart and API to be ready');
      expect(wait.awaitingNewBoot('API + WEB')).toBe('Waiting for a restart and API + WEB to be ready');
      expect(wait.satisfiedNewBoot('API + WEB')).toBe('Restarted; API + WEB ready');
      expect(wait.reasonUnavailable).toBe("Can't read run status right now; this item stays.");
      expect(wait.reasonIncomplete).toBe("Haven't confirmed the live environment meets this condition");
      expect(wait.observed('4 minutes ago')).toBe('As of 4 minutes ago');
      expect(wait.satisfiable(1)).toBe('Expected to satisfy 1 item');
      expect(wait.satisfiable(3)).toBe('Expected to satisfy 3 items');
      const zh = homeCopy.zh.wait;
      expect(zh.awaitingNewBoot('API + WEB')).toBe('等待新启动，API + WEB 就绪');
      expect(zh.satisfiedNewBoot('API')).toBe('已出现新启动，API 已就绪');
      expect(zh.reasonUnavailable).toBe('暂时读不到运行状态，这项等待先保留。');
      expect(zh.reasonIncomplete).toBe('还没确认正式环境已满足这项等待');
      expect(zh.observed('4 分钟前')).toBe('截至 4 分钟前');
      expect(zh.satisfiable(3)).toBe('预计满足 3 项');
    });

    it('shows the empty, loading, error and stale states in English too', async () => {
      mocks.hydration = 'loading';
      await renderHome();
      expect(q('[data-testid="workspace-deployment-waits"]')?.textContent).toBe('Loading waiting items…');

      mocks.hydration = 'error';
      mocks.projection = null;
      await renderHome();
      expect(q('[data-testid="workspace-deployment-waits"]')?.textContent).toBe(
        "Can't load waiting items right now.Retry",
      );

      mocks.hydration = 'error';
      mocks.projection = { projectPath: '/project', candidate: null, items: [] };
      await renderHome();
      expect(text()).toContain('Nothing waiting');
      expect(text()).toContain("Couldn't sync. Showing the last verified list.");
      expect(text()).not.toMatch(CJK);
    });

    it('finds a tool by its Chinese name too, so a query typed in either language works', async () => {
      await renderHome();
      await type('终端');
      expect(qa('[data-workspace-destination]').map((node) => node.dataset.workspaceDestination)).toEqual([
        'surface:terminal',
      ]);
      expect(q('.home-tool-name')?.textContent).toBe('Terminal');
      await type('zzz');
      expect(q('.home-empty-search')?.textContent).toBe('No matches');
    });

    it('words the workspace-search dropdown in English: heading, tags, view-all, and each failure', async () => {
      const found = results(9);
      await renderHome({ workspaceSearch: searchOf({ results: found }), workspaceSearchQuery: 'file' });
      await waitForSearchDebounce();
      expect(text()).toContain('This workspace');
      expect(text()).toContain('View all 9 results');
      const tags = qa('[data-testid="workspace-launcher-file-result"]').map(
        (node) => node.lastElementChild?.textContent,
      );
      expect(tags).toHaveLength(8);
      expect(new Set(tags)).toEqual(new Set(['File name', 'Text']));
      expect(text()).not.toMatch(CJK);
    });
  });

  describe.each(['en', 'zh'] as const)('the dropdown states, worded in %s', (language) => {
    const states: Array<{ name: string; over: Partial<LauncherWorkspaceSearch>; en: string; zh: string }> = [
      {
        name: 'nothing to search',
        over: { enabled: false },
        en: 'No workspace to search. You can still find tools below.',
        zh: '当前没有可搜索的工作区；仍可在下面查找功能入口。',
      },
      {
        name: 'search failed',
        over: { error: 'boom' },
        en: "Couldn't search this workspace. Try again.",
        zh: '暂时没能搜索当前工作区，请重试。',
      },
      {
        name: 'no match',
        over: { results: [] },
        en: 'No files match. Matching tools are listed below.',
        zh: '没有找到文件名或正文匹配；下面仍会保留匹配的功能入口。',
      },
      {
        name: 'still searching',
        over: { loading: true },
        en: 'Searching file names and text…',
        zh: '正在搜索文件名和正文…',
      },
    ];

    it.each(states)('$name', async ({ over, en, zh }) => {
      await setLanguage(language);
      await renderHome({ workspaceSearch: searchOf(over), workspaceSearchQuery: 'query' });
      if (over.enabled !== false) await waitForSearchDebounce();
      expect(text()).toContain(language === 'en' ? en : zh);
      if (over.loading) {
        expect(q('output[aria-label]')?.getAttribute('aria-label')).toBe(
          language === 'en' ? 'Searching this workspace' : '正在搜索当前工作区',
        );
      }
    });
  });

  describe('Chinese is exactly what it was', () => {
    it('keeps the Chinese words, in the same places, when the language is the default', async () => {
      fillTheWholePage();
      await renderHome();
      expect(q('#home-live-title')?.textContent).toBe('正在发生');
      expect(q('#home-wait-title')?.textContent).toBe('等待与接回');
      expect(qa('.home-group-title').map((node) => node.textContent)).toEqual(['活动', '代码', '其他']);
      expect(text()).toContain('等待运行版本包含 bbbbbbbb，API + WEB 就绪');
      expect(text()).toContain('运行版本已包含 dddddddd，API 已就绪');
      expect(text()).toContain('等待新启动，API 就绪');
    });

    it('finds a tool by its English name on a Chinese page', async () => {
      await renderHome();
      await type('terminal');
      expect(qa('[data-workspace-destination]').map((node) => node.dataset.workspaceDestination)).toEqual([
        'surface:terminal',
      ]);
      expect(q('.home-tool-name')?.textContent).toBe('终端');
    });
  });

  it('changes the words without remounting: the typed query and the focus survive a language flip', async () => {
    await renderHome();
    const search = q('[data-testid="workspace-launcher-search"]') as HTMLInputElement;
    act(() => search.focus());
    await type('terminal');
    expect(q('.home-tool-name')?.textContent).toBe('终端');

    await setLanguage('en');
    expect(q('.home-tool-name')?.textContent).toBe('Terminal');
    expect(q('[data-testid="workspace-launcher-search"]')).toBe(search);
    expect(search.value).toBe('terminal');
    expect(document.activeElement).toBe(search);

    await setLanguage('zh');
    expect(q('.home-tool-name')?.textContent).toBe('终端');
    expect(q('[data-testid="workspace-launcher-search"]')).toBe(search);
  });

  describe('the shared search box keeps its classic words unless it is handed others', () => {
    it('shows the classic Chinese dropdown even while the new shell is in English', async () => {
      await setLanguage('en');
      await act(async () => {
        root.render(
          <WorkspaceLauncherSearch
            query="file"
            onQueryChange={vi.fn()}
            workspaceSearch={searchOf({ enabled: false })}
          />,
        );
      });
      expect(text()).toContain('当前没有可搜索的工作区；仍可在下面查找功能入口。');
      expect(q('input')?.getAttribute('placeholder')).toBe('搜索文件、任务、状态或陪伴…');
    });
  });
});
