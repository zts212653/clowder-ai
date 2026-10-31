import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { subscribeTheaterReplay } from '@/components/ThreadSidebar/theater-navigation';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import type { LauncherWorkspaceSearch } from '@/components/workspace/WorkspaceLauncherSearch';
import type { WorkspaceHomeV2 } from '../WorkspaceHomeV2';

const mocks = vi.hoisted(() => ({
  setWorkspaceMode: vi.fn(),
  openTeamSubject: vi.fn(),
  searchProps: [] as Array<{ placeholder?: string; labelClassName?: string }>,
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      setWorkspaceMode: mocks.setWorkspaceMode,
      openTeamSubject: mocks.openTeamSubject,
      threads: [{ id: 'thread-p', title: 'Actual Home conversation' }],
    }),
}));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined }) }));
vi.mock('@/hooks/useActiveExecutionProjection', () => ({ cancelProjectedExecution: vi.fn() }));
vi.mock('@/hooks/useDeploymentWaitProjection', () => ({
  useDeploymentWaitProjection: () => ({ projection: null, hydration: 'idle', error: null, retry: vi.fn() }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn().mockResolvedValue({ ok: false }) }));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => null }));
vi.mock('@/components/ChatVoiceFeatureControls', () => ({ ChatVoiceFeatureControls: () => null }));
vi.mock('@/components/workspace/RecentTrajectoryRecall', () => ({ RecentTrajectoryRecall: () => null }));
vi.mock('@/components/workspace/WorkspaceNowSurface', () => ({ WorkspaceNowSurface: () => null }));
// Exercise the new picker through the original Home admission callbacks. The real + host mount is a browser journey.
vi.mock('@/components/workspace-home/WorkspaceHomeV2', async () => {
  const { WorkspaceToolsContent } = await import('../WorkspaceToolsContent');
  return {
    WorkspaceHomeV2: (props: React.ComponentProps<typeof WorkspaceHomeV2>) => (
      <div data-home-presentation="v2">
        <WorkspaceToolsContent
          onSelectDevSurface={props.onSelectDevSurface}
          onSelectDestination={props.onSelectDestination}
          workspaceSearch={props.workspaceSearch}
          onOpenSettings={vi.fn()}
          onClose={vi.fn()}
          onSelectRecentSurface={vi.fn()}
          recentSurfaces={[]}
        />
        {props.destinationMessage && (
          <output data-testid="f307-destination-admission-status">{props.destinationMessage}</output>
        )}
      </div>
    ),
  };
});
vi.mock('@/components/workspace/WorkspaceLauncherSearch', () => ({
  WorkspaceLauncherSearch: ({
    workspaceSearch,
    placeholder,
    labelClassName,
  }: {
    workspaceSearch?: LauncherWorkspaceSearch;
    placeholder?: string;
    labelClassName?: string;
  }) => {
    mocks.searchProps.push({ placeholder, labelClassName });
    return (
      <button
        type="button"
        data-testid="mock-workspace-search-result"
        onClick={() => workspaceSearch?.onOpenResult('src/found.ts', 42)}
      >
        open result
      </button>
    );
  },
}));

import { F307WorkspaceHomePage } from '../../workbench/F307WorkspaceHomePage';

/** Every destination the new home offers that the classic launcher also offers (the voice row is local to the page). */
const SHARED_DESTINATIONS = [
  'surface:files',
  'surface:changes',
  'surface:git',
  'surface:terminal',
  'surface:browser',
  'host:status',
  'mode:trajectory',
  'mode:recall',
  'mode:product-schedule',
  'workspace:capability-evolution',
];

type Presentation = 'classic' | 'v2';

describe('F322 Workspace home: the new shell chooses exactly what the classic home chooses', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onSelectDevSurface = vi.fn();
  const onSelectSurface = vi.fn<(surface: WorkspaceSurfaceDescriptor) => void>();
  const theaterEvents: string[] = [];
  let unsubscribeTheater: () => void;

  beforeEach(() => {
    vi.stubGlobal('React', React);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.localStorage.clear();
    mocks.setWorkspaceMode.mockReset();
    mocks.openTeamSubject.mockReset();
    mocks.searchProps.length = 0;
    onSelectDevSurface.mockReset();
    onSelectSurface.mockReset();
    theaterEvents.length = 0;
    unsubscribeTheater = subscribeTheaterReplay((threadId) => theaterEvents.push(threadId));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    unsubscribeTheater();
    act(() => root.unmount());
    container.remove();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  async function renderHome(
    presentation: Presentation,
    props: Partial<React.ComponentProps<typeof F307WorkspaceHomePage>> = {},
  ) {
    await act(async () => writeShellPresentation(presentation));
    await act(async () => {
      root.render(
        <F307WorkspaceHomePage
          threadId="thread-p"
          defaultCatId="codex-sol"
          onSelectDevSurface={onSelectDevSurface}
          onSelectSurface={onSelectSurface}
          worktreeId="wt-p"
          openFilePath={null}
          preview={{ path: '/' }}
          {...props}
        />,
      );
    });
  }

  /** Everything observable that choosing a destination causes, from either presentation. */
  async function choose(presentation: Presentation, ref: string, props: Parameters<typeof renderHome>[1] = {}) {
    mocks.setWorkspaceMode.mockReset();
    mocks.openTeamSubject.mockReset();
    onSelectDevSurface.mockReset();
    onSelectSurface.mockReset();
    theaterEvents.length = 0;
    await renderHome(presentation, props);
    const target = container.querySelector<HTMLElement>(`[data-workspace-destination="${ref}"]`);
    expect(target, `${presentation} offers ${ref}`).not.toBeNull();
    await act(async () => target?.click());
    return {
      workspaceMode: mocks.setWorkspaceMode.mock.calls,
      teamSubject: mocks.openTeamSubject.mock.calls,
      devSurface: onSelectDevSurface.mock.calls,
      surfaces: onSelectSurface.mock.calls.map(([surface]) => surface),
      theater: [...theaterEvents],
      admission: container.querySelector('[data-testid="f307-destination-admission-status"]')?.textContent ?? null,
    };
  }

  it.each(SHARED_DESTINATIONS)('%s: same store calls, host callbacks, surface and replay as classic', async (ref) => {
    const classic = await choose('classic', ref);
    const v2 = await choose('v2', ref);
    if (ref === 'mode:product-schedule') {
      expect(classic.surfaces[0]?.title).toBe('Schedule');
      expect(v2.surfaces[0]?.title).toBe('日程');
      // The translated heading is presentation; all owner coordinates and callbacks remain exact.
      expect({ ...v2, surfaces: v2.surfaces.map((surface) => ({ ...surface, title: 'Schedule' })) }).toEqual(classic);
    } else {
      expect(v2).toEqual(classic);
    }
  });

  it('keeps classic replay on its single legacy owner without admitting a second F307 player', async () => {
    const classic = await choose('classic', 'action:theater');
    expect(classic.theater).toEqual(['thread-p']);
    expect(classic.surfaces).toEqual([]);
  });

  it('opens v2 replay only through the Home descriptor with its actual conversation title', async () => {
    const v2 = await choose('v2', 'action:theater');
    expect(v2.theater).toEqual([]);
    expect(v2.surfaces).toHaveLength(1);
    expect(v2.surfaces[0]).toMatchObject({
      type: 'thread-replay',
      context: 'Actual Home conversation',
      objectRef: { kind: 'thread-replay', id: 'thread-p' },
    });
  });

  it.each([
    'surface:files',
    'surface:changes',
    'surface:terminal',
  ])('%s: same pending and no-workspace admission as classic', async (ref) => {
    for (const props of [
      { worktreeId: null, worktreeLoading: true },
      { worktreeId: null, worktreeLoading: false, worktreeError: null },
      { worktreeId: null, worktreeLoading: false, worktreeError: '没有工作区权限' },
    ]) {
      const classic = await choose('classic', ref, props);
      const v2 = await choose('v2', ref, props);
      expect(v2).toEqual(classic);
      expect(v2.admission).not.toBeNull();
    }
  });

  it('opens the replay only when there is a conversation, in both', async () => {
    const classic = await choose('classic', 'action:theater', { threadId: undefined });
    const v2 = await choose('v2', 'action:theater', { threadId: undefined });
    expect(v2).toEqual(classic);
    expect(v2.theater).toEqual([]);
  });

  it('delivers the same search hit to the original host while v2 lets the stamp consumer own dispatch', async () => {
    const search: LauncherWorkspaceSearch = {
      enabled: true,
      results: [],
      loading: false,
      error: null,
      onSearch: vi.fn(),
      onReset: vi.fn(),
      onOpenResult: vi.fn(),
      onViewAll: vi.fn(),
      fileNavigationOrigin: () => ({ kind: 'workspace-home-search', query: 'found' }),
    };
    const outcomes: Partial<
      Record<Presentation, { hostSawResult: unknown[][]; surfaces: WorkspaceSurfaceDescriptor[] }>
    > = {};
    for (const presentation of ['classic', 'v2'] as const) {
      onSelectSurface.mockReset();
      vi.mocked(search.onOpenResult).mockReset();
      mocks.searchProps.length = 0;
      await renderHome(presentation, { workspaceSearch: search });
      await act(async () =>
        container.querySelector<HTMLElement>('[data-testid="mock-workspace-search-result"]')?.click(),
      );
      outcomes[presentation] = {
        hostSawResult: vi.mocked(search.onOpenResult).mock.calls,
        surfaces: onSelectSurface.mock.calls.map(([surface]) => surface),
      };
    }
    expect(outcomes.v2?.hostSawResult).toEqual([['src/found.ts', 42]]);
    expect(outcomes.v2?.hostSawResult).toEqual(outcomes.classic?.hostSawResult);
    expect(outcomes.classic?.surfaces).toHaveLength(1);
    expect(outcomes.v2?.surfaces).toHaveLength(0);

    // The classic box keeps its own words and field (props unset); the new one says what it searches.
    expect(mocks.searchProps.at(-1)).toEqual({ placeholder: '搜索文件和工具…', labelClassName: 'home-search' });
    mocks.searchProps.length = 0;
    await renderHome('classic', { workspaceSearch: search });
    expect(mocks.searchProps.at(-1)).toEqual({ placeholder: undefined, labelClassName: undefined });
  });

  it('is the switch that decides: v2 renders the new home, classic renders the classic one, live', async () => {
    await renderHome('v2');
    expect(container.querySelector('[data-home-presentation="v2"]')).not.toBeNull();
    expect(container.textContent).not.toContain('你想打开什么？');

    await act(async () => writeShellPresentation('classic'));
    expect(container.querySelector('[data-home-presentation="v2"]')).toBeNull();
    expect(container.textContent).toContain('你想打开什么？');
    expect(container.querySelector('[data-testid="workspace-launcher-dev-files"]')).not.toBeNull();

    await act(async () => writeShellPresentation('v2'));
    expect(container.querySelector('[data-home-presentation="v2"]')).not.toBeNull();
  });
});
