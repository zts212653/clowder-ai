import type { ActiveExecutionProjection } from '@cat-cafe/shared';

// The workbench kernel also mounts outside the Next app router (browser review hosts bundle it with
// Vite), so it takes navigation from its host. Override the global test-setup router with the real
// out-of-router behavior: any router hook in this tree fails here the same way it fails there.
vi.mock('next/navigation', () => ({
  useRouter: () => {
    throw new Error('invariant expected app router to be mounted');
  },
}));

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeTeamWorkspaceSubject } from '@/components/routing-context/team-navigation';
import { openExactPlace } from '@/components/shell/mailbox/open-exact-place';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { createInitialWorkbenchState } from '@/components/workbench/workbench-model';
import { WORKBENCH_STORAGE_KEY } from '@/components/workbench/workbench-persistence';
import {
  clearExecutionDetailRequest,
  requestExecutionDetail,
} from '@/components/workspace-home/execution-detail-request';
import type { WorkspaceOpenRequest } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { createArtifactReviewSurface } from '../artifact-review-surface';
import { createArtifactWorkPresentationState } from '../artifact-work-presentation';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { F307ExperienceWorkbench } from '../F307ExperienceWorkbench';
import {
  createBrowserSurface,
  createEvolutionProgramSurface,
  createFilePreviewSurface,
  createFileSurface,
  createProductScheduleReturnSurface,
  createTerminalSurface,
  createWorkspaceDestinationSurface,
  createWorkspaceModeSurface,
  resolveChangesTarget,
  resolveFilesTarget,
  resolveFileTarget,
} from '../real-surface-adapters';
import { createThreadReplaySurface } from '../thread-replay-surface';

const mocks = vi.hoisted(() => ({
  openAppRoute: vi.fn(),
  isDesktop: true,
  useNativeViewport: false,
  workbenchVisible: true,
  executionsByKey: {} as Record<string, ActiveExecutionProjection>,
}));

vi.mock('@/components/listen-mode/ListenModePlayer', () => ({
  ListenModePlayer: ({ variant = 'workspace' }: { variant?: string }) => (
    <output data-testid="workbench-listen" data-variant={variant} />
  ),
}));

vi.mock('@/hooks/useIsDesktop', async (importOriginal) => {
  const native = await importOriginal<typeof import('@/hooks/useIsDesktop')>();
  return {
    useIsDesktop: () => {
      const desktop = native.useIsDesktop();
      return mocks.useNativeViewport ? desktop : mocks.isDesktop;
    },
  };
});

vi.mock('@/stores/activeExecutionStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/activeExecutionStore')>()),
  useActiveExecutionStore: (
    selector: (state: { executionsByKey: Record<string, ActiveExecutionProjection> }) => unknown,
  ) => selector({ executionsByKey: mocks.executionsByKey }),
}));

vi.mock('../F307OwnerSurfaceRenderer', () => ({
  F307OwnerSurfaceRenderer: ({
    surface,
    surfaceVisible,
    focusMode,
    onOpenSurface,
    onReturnToFileOrigin,
  }: {
    surface: WorkspaceSurfaceDescriptor;
    surfaceVisible?: boolean;
    focusMode?: boolean;
    onOpenSurface?: (surface: WorkspaceSurfaceDescriptor) => void;
    onReturnToFileOrigin?: (
      surface: WorkspaceSurfaceDescriptor,
      origin: NonNullable<WorkspaceSurfaceDescriptor['navigationOrigin']>,
    ) => void;
  }) => {
    const origin = surface.navigationOrigin;
    const [week, setWeek] = React.useState('5–11');
    return (
      <div
        data-testid={`owner-surface-${surface.type}`}
        data-owner-surface-id={surface.id}
        data-surface-visible={String(surfaceVisible)}
        data-focus-mode={String(focusMode)}
      >
        {surface.title}
        <button type="button" data-testid={`owner-week-${surface.id}`} onClick={() => setWeek('12–18')}>
          {week}
        </button>
        {surface.objectRef.kind === 'workspace-destination' && surface.objectRef.id === 'surface:changes' ? (
          <button type="button" data-testid="open-changes-file" onClick={() => onOpenSurface?.(FILE_SURFACE)}>
            打开文件
          </button>
        ) : null}
        {origin ? (
          <button
            type="button"
            data-testid={`return-origin-${surface.id}`}
            onClick={() => onReturnToFileOrigin?.(surface, origin)}
          >
            返回来源
          </button>
        ) : null}
      </div>
    );
  },
}));

vi.mock('../F307SurfacePane', () => ({
  F307SurfacePane: ({
    children,
    surface,
    visible,
    focusMode,
    onEnterFocusMode,
    onExitFocusMode,
    artifactWorkFullWindow,
    onToggleArtifactWorkFullWindow,
  }: {
    children: React.ReactNode;
    surface: WorkspaceSurfaceDescriptor;
    visible: boolean;
    focusMode?: boolean;
    onEnterFocusMode?: () => void;
    onExitFocusMode?: () => void;
    artifactWorkFullWindow?: boolean;
    onToggleArtifactWorkFullWindow?: () => void;
  }) => (
    <div data-visible={visible} data-surface-id={surface.id} data-focus-mode={String(focusMode)}>
      {onToggleArtifactWorkFullWindow ? (
        <button type="button" data-testid="artifact-work-toggle" onClick={onToggleArtifactWorkFullWindow}>
          {artifactWorkFullWindow ? '展开聊天' : '整窗'}
        </button>
      ) : (
        <button
          type="button"
          data-testid={focusMode ? 'workspace-focus-exit' : 'workspace-focus-enter'}
          onClick={focusMode ? onExitFocusMode : onEnterFocusMode}
        >
          {focusMode ? '退出专注' : '专注'}
        </button>
      )}
      {children}
    </div>
  ),
}));

vi.mock('../F307WorkbenchSidecar', async (importOriginal) => {
  const original = await importOriginal<typeof import('../F307WorkbenchSidecar')>();
  return {
    ...original,
    F307MountedSurface: (props: React.ComponentProps<typeof original.F307MountedSurface>) => (
      <div data-testid={props.sidecar ? 'workbench-sidecar' : undefined} data-visible={String(props.visible)}>
        <original.F307MountedSurface {...props} />
      </div>
    ),
    F307WorkbenchSidecar: ({
      surface,
      renderSurface,
      visible = true,
    }: {
      surface: WorkspaceSurfaceDescriptor;
      renderSurface: (surface: WorkspaceSurfaceDescriptor, visible: boolean) => React.ReactNode;
      visible?: boolean;
    }) => (
      <div data-testid="workbench-sidecar" data-visible={visible}>
        {renderSurface(surface, visible)}
      </div>
    ),
  };
});

vi.mock('../F307WorkspaceHomePage', () => ({
  F307WorkspaceHomePage: ({
    workspaceSearchQuery,
    workspaceSearchReturnOrigin,
    threadId,
    onSelectSurface,
  }: {
    workspaceSearchQuery?: string;
    workspaceSearchReturnOrigin?: { viewportOffsetPx?: number };
    threadId: string;
    onSelectSurface: (surface: WorkspaceSurfaceDescriptor) => void;
  }) => (
    <div
      data-testid="f307-workspace-home-page"
      data-workspace-search-query={workspaceSearchQuery ?? ''}
      data-search-offset={workspaceSearchReturnOrigin?.viewportOffsetPx}
    >
      Canonical Workspace Home
      {(['artifacts', 'schedule'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          data-testid={`home-select-${mode}`}
          onClick={() => onSelectSurface(createWorkspaceModeSurface(mode, threadId))}
        >
          {mode}
        </button>
      ))}
    </div>
  ),
}));

const FILE_SURFACE: WorkspaceSurfaceDescriptor = {
  id: 'file-owner:worktree-a',
  type: 'code',
  renderer: 'code-editor',
  title: 'owner.ts',
  context: 'worktree-a · owner.ts',
  objectRef: { kind: 'file', id: 'worktree-a' },
  ownerStateRef: { owner: 'f063-workspace-file', key: 'worktree-a' },
  resultTargetRef: { owner: 'f063-workspace-file', key: 'worktree-a:owner.ts' },
  capabilities: {
    split: true,
    sidecar: true,
    pin: true,
    closePolicy: 'detach-host',
    restorePolicy: 'descriptor',
  },
};

const AGENT_RUN_SURFACE: WorkspaceSurfaceDescriptor = {
  id: 'agent-run:invocation-f307',
  type: 'agent-run',
  renderer: 'agent-run',
  title: 'clowder-ai#1408: 官网与文档发布边界',
  context: 'Invocation · invocation-f307',
  objectRef: { kind: 'agent-run', id: 'invocation-f307' },
  ownerStateRef: { owner: 'f299-invocation-trajectory', key: 'thread-f307:invocation-f307' },
  resultTargetRef: { owner: 'f299-invocation-trajectory', key: 'thread-f307:invocation-f307' },
  capabilities: {
    split: true,
    sidecar: true,
    pin: true,
    closePolicy: 'detach-host',
    restorePolicy: 'descriptor',
  },
};

const PROGRAM_SURFACE = createEvolutionProgramSurface(`evolution-program:${'a'.repeat(32)}`, '文档审阅方式');
const ARTIFACT_SURFACE = createArtifactReviewSurface(`review-${'b'.repeat(64)}`, 'thread-a', '作品审阅');
const BROWSER_SURFACE = createBrowserSurface({ ownerKey: 'preview-f307', port: 4173, path: '/owner-a' });
const TERMINAL_SURFACE = createTerminalSurface({ worktreeId: 'worktree-a' });

const hydrateWorkbench = useF307ExperienceWorkbenchStore.getState().hydrate;

describe('F307 zero-surface canonical Home invariant', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    useChatStore.setState({ currentThreadId: 'thread-a' });
    mocks.isDesktop = true;
    mocks.useNativeViewport = false;
    mocks.workbenchVisible = true;
    mocks.executionsByKey = {};
    window.localStorage.clear();
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState(),
      hydrated: true,
      mainAreaAttentionSurfaceId: null,
      focusSurfaceId: null,
      artifactWorkPresentation: createArtifactWorkPresentationState(),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    writeShellPresentation('classic');
    container.remove();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    useChatStore.setState({ currentThreadId: undefined, rightPanelMode: 'status' });
    useToastStore.setState({ toasts: [] });
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState(),
      hydrated: false,
      mainAreaAttentionSurfaceId: null,
      focusSurfaceId: null,
      artifactWorkPresentation: createArtifactWorkPresentationState(),
      hydrate: hydrateWorkbench,
    });
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
  });

  async function renderWorkbench(
    workspaceOpenRequest?: WorkspaceOpenRequest,
    onConsumed?: (revision: number) => void,
    options?: {
      onRestoreWorkspaceSearch?: (query: string) => void;
      onReturnToChatMessage?: (input: { threadId: string; messageId: string }) => void;
    },
  ) {
    await act(async () => {
      root.render(
        <F307ExperienceWorkbench
          threadId="thread-a"
          visible={mocks.workbenchVisible}
          artifactWorkHostAvailable
          onSelectDevSurface={() => undefined}
          worktreeId="worktree-a"
          openFilePath={null}
          preview={{ path: '/' }}
          workspaceOpenRequest={workspaceOpenRequest}
          onWorkspaceOpenRequestConsumed={onConsumed}
          onRestoreWorkspaceSearch={options?.onRestoreWorkspaceSearch}
          onReturnToChatMessage={options?.onReturnToChatMessage}
          onOpenAppRoute={mocks.openAppRoute}
        />,
      );
    });
  }

  it('records a genuine host-thread request and reselect without inferring tab order', async () => {
    const target = createWorkspaceModeSurface('artifacts', 'thread-a');
    const request = {
      revision: 1,
      threadId: 'thread-a',
      target: { kind: 'mode' as const, mode: 'artifacts' as const },
    };
    await renderWorkbench(request);
    expect(container.querySelector('[data-testid="workbench-listen"]')?.getAttribute('data-variant')).toBe('workspace');
    expect(useF307ExperienceWorkbenchStore.getState().layout.recentSurfaceIdsByThread?.['thread-a']).toEqual([
      target.id,
    ]);
    const layout = useF307ExperienceWorkbenchStore.getState().layout;
    useF307ExperienceWorkbenchStore.setState({ layout: { ...layout, recentSurfaceIdsByThread: {} } });
    await renderWorkbench({ ...request, revision: 2 });
    expect(useF307ExperienceWorkbenchStore.getState().layout.recentSurfaceIdsByThread?.['thread-a']).toEqual([
      target.id,
    ]);
  });

  it('returns a pure publication to Home before the file-only guard and keeps its tab', async () => {
    const source = createFileSurface({ worktreeId: 'worktree-a', path: 'unrelated.md' });
    const origin = {
      kind: 'workspace-home-artifact' as const,
      threadId: 'thread-a',
      artifactId: encodeURIComponent(JSON.stringify(['image', null, '/uploads/work.png', 'message', 17, 'work'])),
      viewportOffsetPx: 84,
    };
    const publication = { ...ARTIFACT_SURFACE, navigationOrigin: origin };
    useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([publication, source]) });
    await renderWorkbench();
    const back = container.querySelector<HTMLButtonElement>(`[data-testid="return-origin-${publication.id}"]`);
    if (!back) throw new Error('The real owner Back callback is missing');
    await act(async () => back.click());
    expect(
      container.querySelector('[data-testid="f307-experience-workbench"]')?.getAttribute('data-workbench-focus'),
    ).toBe('home');
    expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces).toEqual([publication, source]);
  });

  it('keeps a cold explicit execution request above restored foreground, then honors a new foreground input', async () => {
    const previousChat = useChatStore.getState();
    useChatStore.setState({ currentThreadId: 'thread-a', presentationLock: null });
    clearExecutionDetailRequest();
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([BROWSER_SURFACE, TERMINAL_SURFACE]),
    });
    const execution: ActiveExecutionProjection = {
      kind: 'managed_command',
      executionId: 'cold-managed',
      catId: 'codex61-sol',
      threadId: 'thread-source',
      threadTitle: 'source',
      startedAt: 17,
      activity: 'test',
      cancelability: { state: 'not_cancelable', reason: 'foreign_principal' },
    };
    const renderForeground = (foregroundSurfaceId: string) =>
      root.render(
        <F307ExperienceWorkbench
          threadId="thread-a"
          foregroundSurfaceId={foregroundSurfaceId}
          visible
          artifactWorkHostAvailable
          onSelectDevSurface={() => undefined}
          worktreeId="worktree-a"
          openFilePath={null}
          preview={{ path: '/' }}
          onOpenAppRoute={mocks.openAppRoute}
        />,
      );
    try {
      // Queue the real transient request before the host mounts with a valid nonempty old foreground.
      act(() => requestExecutionDetail(execution));
      await act(async () => renderForeground(BROWSER_SURFACE.id));
      expect(
        container.querySelector('[data-testid="f307-experience-workbench"]')?.getAttribute('data-workbench-focus'),
      ).toBe('home');
      act(() =>
        useF307ExperienceWorkbenchStore.getState().dispatch({
          type: 'activate-surface',
          surfaceId: TERMINAL_SURFACE.id,
          entitlement: { kind: 'user', reason: 'surface-tab' },
        }),
      );
      await act(async () => renderForeground(TERMINAL_SURFACE.id));
      expect(
        container.querySelector('[data-testid="f307-experience-workbench"]')?.getAttribute('data-workbench-focus'),
      ).toBe('surface');
    } finally {
      clearExecutionDetailRequest();
      useChatStore.setState(previousChat);
    }
  });

  it.each([false, true])('reveals the exact Inbox review from Home, with an existing tab = %s', async (existing) => {
    writeShellPresentation('v2');
    const reviewId = `review-${'a'.repeat(64)}`;
    const review = createArtifactReviewSurface(reviewId, 'thread-a');
    const previousChat = useChatStore.getState();
    useChatStore.setState({ currentThreadId: 'thread-a', workspaceForegroundSurfaceId: null });
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState(existing ? [review] : []),
    });
    function ForegroundHost() {
      const foregroundSurfaceId = useChatStore((state) => state.workspaceForegroundSurfaceId);
      return (
        <F307ExperienceWorkbench
          threadId="thread-a"
          foregroundSurfaceId={foregroundSurfaceId}
          visible
          artifactWorkHostAvailable
          onSelectDevSurface={() => undefined}
          worktreeId="worktree-a"
          openFilePath={null}
          preview={{ path: '/' }}
          onOpenAppRoute={mocks.openAppRoute}
        />
      );
    }
    try {
      // The mailbox can open Workspace before its automatic foreground binding mounts.
      await act(async () => openExactPlace(`workspace:content-review:thread-a:${reviewId}`, '/thread/thread-a'));
      await act(async () => root.render(<ForegroundHost />));
      expect(container.querySelector('[data-workbench-focus="surface"]')).not.toBeNull();
      expect(
        container.querySelector(`[data-owner-surface-id="${review.id}"]`)?.getAttribute('data-surface-visible'),
      ).toBe('true');
      expect(useChatStore.getState().workspaceForegroundSurfaceId).toBe(review.id);
      expect(useChatStore.getState().threadStates['thread-a'].workspaceForegroundSurfaceId).toBe(review.id);
    } finally {
      useChatStore.setState({
        currentThreadId: previousChat.currentThreadId,
        workspaceForegroundSurfaceId: previousChat.workspaceForegroundSurfaceId,
        threadStates: previousChat.threadStates,
      });
    }
  });

  it('reveals the existing active artifacts owner when an explicit works entry leaves Home', async () => {
    writeShellPresentation('v2');
    const artifacts = createWorkspaceModeSurface('artifacts', 'thread-a');
    const schedule = createWorkspaceModeSurface('schedule', 'thread-a');
    const previousChat = useChatStore.getState();
    useChatStore.setState({ currentThreadId: 'thread-a', workspaceForegroundSurfaceId: null });
    useF307ExperienceWorkbenchStore.setState({
      layout: { ...createInitialWorkbenchState([schedule, artifacts]), activeSurfaceId: artifacts.id },
    });
    const onConsumed = vi.fn();
    function ForegroundHost({ request }: { request?: WorkspaceOpenRequest }) {
      const foregroundSurfaceId = useChatStore((state) => state.workspaceForegroundSurfaceId);
      return (
        <F307ExperienceWorkbench
          threadId="thread-a"
          foregroundSurfaceId={foregroundSurfaceId}
          artifactWorkHostAvailable
          onSelectDevSurface={() => undefined}
          worktreeId="worktree-a"
          openFilePath={null}
          preview={{ path: '/' }}
          workspaceOpenRequest={request}
          onWorkspaceOpenRequestConsumed={onConsumed}
          onOpenAppRoute={mocks.openAppRoute}
        />
      );
    }
    try {
      await act(async () => root.render(<ForegroundHost />));
      expect(container.querySelector('[data-workbench-focus="home"]')).not.toBeNull();
      const owner = container.querySelector(`[data-owner-surface-id="${artifacts.id}"]`);
      expect(owner?.getAttribute('data-surface-visible')).toBe('false');
      await act(async () =>
        root.render(
          <ForegroundHost
            request={{ revision: 1, threadId: 'thread-a', target: { kind: 'mode', mode: 'artifacts' } }}
          />,
        ),
      );
      expect(useChatStore.getState().workspaceForegroundSurfaceId).toBe(artifacts.id);
      expect(useChatStore.getState().threadStates['thread-a'].workspaceForegroundSurfaceId).toBe(artifacts.id);
      expect(container.querySelector('[data-workbench-focus="surface"]')).not.toBeNull();
      expect(container.querySelector(`[data-owner-surface-id="${artifacts.id}"]`)).toBe(owner);
      expect(owner?.getAttribute('data-surface-visible')).toBe('true');
      expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces).toEqual([schedule, artifacts]);
      expect(onConsumed).toHaveBeenCalledExactlyOnceWith(1);
    } finally {
      useChatStore.setState({
        workspaceForegroundSurfaceId: previousChat.workspaceForegroundSurfaceId,
        threadStates: previousChat.threadStates,
      });
    }
  });

  it.each([
    'v2',
    'classic',
  ] as const)('preserves %s status identity while recently closed titles follow presentation and language', async (presentation) => {
    writeShellPresentation(presentation);
    writeShellLanguage('zh');
    const status = createWorkspaceDestinationSurface(
      { kind: 'host', id: 'status', label: '状态与会话', description: '来源原文', searchTerms: 'status' },
      'thread-a',
    )!;
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([status]),
      hydrated: true,
    });
    await renderWorkbench();
    const close = container.querySelector<HTMLButtonElement>(
      presentation === 'v2'
        ? '[data-tab-surface-id="workspace:host:status"] [data-workbench-tab-control="close"]'
        : '[data-testid="f307-close-workspace"]',
    )!;
    await act(async () => close.click());
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="f307-recently-closed-toggle"]')!;
    await act(async () => toggle.click());
    const restore = container.querySelector<HTMLButtonElement>('[data-testid="f307-restore-workspace"]')!;
    expect(restore.textContent).toBe('恢复 状态与会话');
    await act(async () => writeShellLanguage('en'));
    expect(container.querySelector('[data-testid="f307-restore-workspace"]')).toBe(restore);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(restore.textContent).toBe(presentation === 'v2' ? 'Restore Status & sessions' : '恢复 状态与会话');
    expect(useF307ExperienceWorkbenchStore.getState().layout.recentlyClosed).toEqual([status]);
    await act(async () => writeShellLanguage('zh'));
    expect(restore.textContent).toBe('恢复 状态与会话');
    await act(async () => writeShellLanguage('en'));
    await act(async () => restore.click());
    expect(useF307ExperienceWorkbenchStore.getState().layout).toMatchObject({
      surfaces: [status],
      activeSurfaceId: status.id,
      recentlyClosed: [],
    });
  });

  it('turns a wide Program into explicit full-window and restores the same Chat split from a named control', async () => {
    const presentation = { kind: 'chat-workspace' as const, threadId: 'thread-a', chatBasis: 37 };
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([PROGRAM_SURFACE]),
      hydrated: true,
      mainAreaAttentionSurfaceId: PROGRAM_SURFACE.id,
      mainAreaAttentionPresentation: presentation,
    });
    await renderWorkbench();

    const enter = container.querySelector<HTMLButtonElement>('[data-testid="f307-enter-main-area"]');
    expect(enter?.getAttribute('aria-label')).toBe(`整窗打开 ${PROGRAM_SURFACE.title}`);
    await act(async () => enter?.click());
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionPresentation).toEqual({
      ...presentation,
      mode: 'full-window',
    });

    const back = container.querySelector<HTMLButtonElement>('[data-testid="f307-return-from-main-area"]');
    expect(back?.textContent).toContain('回到聊天');
    await act(async () => back?.click());
    expect(useF307ExperienceWorkbenchStore.getState()).toMatchObject({
      mainAreaAttentionSurfaceId: PROGRAM_SURFACE.id,
      mainAreaAttentionPresentation: presentation,
    });
  });

  it.each([
    ['artifacts', 'launcher'],
    ['schedule', 'launcher'],
    ['artifacts', 'tab'],
    ['schedule', 'tab'],
  ] as const)('reenters the same active %s owner from Home via %s', async (mode, entry) => {
    const { bindWorkspaceForeground } = await import('../workspace-presentation-lock');
    writeShellPresentation('v2');
    const surface = createWorkspaceModeSurface(mode, 'thread-a');
    const previousChat = useChatStore.getState();
    useChatStore.setState({ currentThreadId: 'thread-a', workspaceForegroundSurfaceId: surface.id });
    useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([surface]) });
    const unbind = bindWorkspaceForeground();
    function Host() {
      const foregroundSurfaceId = useChatStore((state) => state.workspaceForegroundSurfaceId);
      return (
        <F307ExperienceWorkbench
          threadId="thread-a"
          foregroundSurfaceId={foregroundSurfaceId}
          onOpenHome={() => useChatStore.getState().setWorkspaceForegroundSurfaceId(null)}
          onOpenAppRoute={mocks.openAppRoute}
          onSelectDevSurface={() => undefined}
          worktreeId="worktree-a"
          openFilePath={null}
          preview={{ path: '/' }}
        />
      );
    }
    try {
      await act(async () => root.render(<Host />));
      const owner = container.querySelector(`[data-owner-surface-id="${surface.id}"]`);
      expect(owner?.getAttribute('data-surface-visible')).toBe('true');
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="v2-workspace-home"]')!.click());
      expect(useChatStore.getState().workspaceForegroundSurfaceId).toBeNull();
      expect(container.querySelector('[data-workbench-focus="home"]')).not.toBeNull();
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            entry === 'launcher' ? `[data-testid="home-select-${mode}"]` : `[data-tool-surface-id="${surface.id}"]`,
          )!
          .click(),
      );
      expect(useChatStore.getState().workspaceForegroundSurfaceId).toBe(surface.id);
      expect(useChatStore.getState().threadStates['thread-a'].workspaceForegroundSurfaceId).toBe(surface.id);
      expect(container.querySelector('[data-workbench-focus="surface"]')).not.toBeNull();
      expect(container.querySelector(`[data-owner-surface-id="${surface.id}"]`)).toBe(owner);
      expect(owner?.getAttribute('data-surface-visible')).toBe('true');
      expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces).toHaveLength(1);
    } finally {
      unbind();
      useChatStore.setState(previousChat, true);
    }
  });

  it('uses the KD-25 Artifact toggle instead of generic main-area attention', async () => {
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([ARTIFACT_SURFACE]),
      artifactWorkPresentation: createArtifactWorkPresentationState(),
    });
    await renderWorkbench();

    expect(container.querySelector('[data-testid="f307-enter-main-area"]')).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="artifact-work-toggle"]');
    expect(toggle).toBeTruthy();
    await act(async () => toggle?.click());
    expect(useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation.session).toMatchObject({
      mode: 'full-window',
      threadId: 'thread-a',
      surfaceId: ARTIFACT_SURFACE.id,
    });
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();

    await act(async () => toggle?.click());
    expect(useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation.session?.mode).toBe('split');
  });

  it('offers the original full-window controller to the v2 browser owner', async () => {
    writeShellPresentation('v2');
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([BROWSER_SURFACE]),
      focusSurfaceId: BROWSER_SURFACE.id,
    });
    await renderWorkbench();
    const owner = container.querySelector('[data-testid="owner-surface-browser"]');
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="artifact-work-toggle"]');
    expect(toggle).not.toBeNull();
    await act(async () => toggle?.click());
    expect(useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation.session).toMatchObject({
      surfaceId: BROWSER_SURFACE.id,
      mode: 'full-window',
    });
    expect(container.querySelector('[data-testid="owner-surface-browser"]')).toBe(owner);
  });

  it('opens and focuses the canonical Approval surface for an external Workspace entry', async () => {
    const onConsumed = vi.fn();
    await renderWorkbench(
      {
        revision: 1,
        threadId: 'thread-a',
        target: { kind: 'mode', mode: 'approval' },
      },
      onConsumed,
    );

    const { layout } = useF307ExperienceWorkbenchStore.getState();
    expect(layout.activeSurfaceId).toBe('workspace:mode:approval');
    expect(layout.surfaces).toHaveLength(1);
    expect(layout.surfaces[0]).toMatchObject({
      objectRef: { kind: 'workspace-destination', id: 'mode:approval' },
      ownerStateRef: { owner: 'f284-workspace-launcher', key: 'mode:approval' },
    });
    expect(onConsumed).toHaveBeenCalledWith(1);
  });

  it('opens the exact file a settings link left pending before this Workbench mounted', async () => {
    // Parent Alpha entry 8: the request is written on /settings and consumed by the lobby's new Workbench.
    const onConsumed = vi.fn();
    const navigationOrigin = {
      kind: 'settings' as const,
      href: '/settings?s=system',
      anchorId: 'settings-file:cat-template.json',
      viewportOffsetPx: 0,
    };
    await renderWorkbench(
      {
        revision: 3,
        threadId: 'thread-a',
        target: { kind: 'file', worktreeId: 'settings-root', path: 'cat-template.json', navigationOrigin },
      },
      onConsumed,
    );

    const { layout } = useF307ExperienceWorkbenchStore.getState();
    const active = layout.surfaces.find((surface) => surface.id === layout.activeSurfaceId);
    expect(active && resolveFileTarget(active)).toMatchObject({
      worktreeId: 'settings-root',
      path: 'cat-template.json',
    });
    expect(active?.navigationOrigin).toEqual(navigationOrigin);
    expect(onConsumed).toHaveBeenCalledWith(3);
  });

  it('shows the directory a settings link asked for, re-runs a repeated reveal, and returns to Settings', async () => {
    // Parent Alpha 2026-09-24 second round: the Settings directory entry left the page unchanged.
    const onConsumed = vi.fn();
    const navigationOrigin = {
      kind: 'settings' as const,
      href: '/settings?s=system',
      anchorId: 'settings-dir:packages/api/uploads',
      viewportOffsetPx: 12,
    };
    const reveal = (revision: number): WorkspaceOpenRequest => ({
      revision,
      threadId: 'thread-a',
      target: {
        kind: 'reveal',
        worktreeId: 'settings-root',
        path: 'packages/api/uploads',
        navigationOrigin,
        repoRoot: '/settings-project',
      },
    });
    const activeSurface = () => {
      const { layout } = useF307ExperienceWorkbenchStore.getState();
      return layout.surfaces.find((surface) => surface.id === layout.activeSurfaceId);
    };

    await renderWorkbench(reveal(4), onConsumed);
    let active = activeSurface();
    // Parent Alpha 2026-09-25: the tree must read its branch/HEAD through the root Settings resolved it under.
    expect(active && resolveFilesTarget(active)).toEqual({
      worktreeId: 'settings-root',
      repoRoot: '/settings-project',
    });
    expect(active?.filesReveal).toEqual({ path: 'packages/api/uploads', request: 4 });
    expect(active?.navigationOrigin).toEqual(navigationOrigin);
    expect(onConsumed).toHaveBeenCalledWith(4);

    // The same tree is already focused; asking again must still reach the tree instead of being skipped.
    await renderWorkbench(reveal(5), onConsumed);
    active = activeSurface();
    expect(active?.filesReveal).toEqual({ path: 'packages/api/uploads', request: 5 });
    expect(onConsumed).toHaveBeenCalledWith(5);

    await act(async () =>
      container.querySelector<HTMLButtonElement>(`[data-testid="return-origin-${active?.id}"]`)?.click(),
    );
    const url = new URL(mocks.openAppRoute.mock.lastCall![0], window.location.origin);
    expect(url.pathname).toBe('/settings');
    expect(url.searchParams.get('s')).toBe('system');
    expect(JSON.parse(url.searchParams.get('fileReturn')!)).toEqual({
      anchorId: 'settings-dir:packages/api/uploads',
      viewportOffsetPx: 12,
    });
  });

  it('Phase U: opens a review beside chat until the human explicitly enters Artifact full-window', async () => {
    const surface = createArtifactReviewSurface(`review-${'a'.repeat(64)}`, 'thread-a', '书房');
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([surface]),
      hydrated: true,
      mainAreaAttentionSurfaceId: null,
    });
    await renderWorkbench();
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
    expect(container.querySelector('[data-testid="owner-surface-review"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="f307-enter-main-area"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="artifact-work-toggle"]')?.click());
    expect(useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation.session).toMatchObject({
      surfaceId: surface.id,
      mode: 'full-window',
    });
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
  });

  it('keeps a permanent legacy file identity when an older explicit request omits disposition and updates its line', async () => {
    writeShellPresentation('v2');
    const file = createFileSurface({ worktreeId: 'existing-root', path: 'A.md' });
    useF307ExperienceWorkbenchStore.setState({
      layout: { ...createInitialWorkbenchState([file]), pinnedSurfaceIds: [file.id] },
    });
    await renderWorkbench({
      revision: 1,
      threadId: 'thread-a',
      target: { kind: 'file', worktreeId: 'existing-root', path: 'A.md', line: 37 },
    });
    const layout = useF307ExperienceWorkbenchStore.getState().layout;
    expect(layout.surfaces).toHaveLength(1);
    expect(layout.activeSurfaceId).toBe(file.id);
    expect(layout.surfaces[0]?.objectRef).toEqual(file.objectRef);
    expect(layout.pinnedSurfaceIds).toEqual([file.id]);
    expect(resolveFileTarget(layout.surfaces[0])?.scrollToLine).toBe(37);
  });

  it('refreshes the exact return origin when the active permanent file is reopened at the same line', async () => {
    writeShellPresentation('v2');
    const first = { kind: 'chat-file-link', threadId: 'thread-a', messageId: 'source-A' } as const;
    const next = { ...first, messageId: 'source-B' };
    const file = createFilePreviewSurface({
      worktreeId: 'existing-root',
      path: 'A.md',
      scrollToLine: 7,
      navigationOrigin: first,
    });
    useF307ExperienceWorkbenchStore.setState({
      layout: { ...createInitialWorkbenchState([file]), pinnedSurfaceIds: [file.id] },
    });
    await renderWorkbench({
      revision: 1,
      threadId: 'thread-a',
      disposition: 'preview',
      target: { kind: 'file', worktreeId: 'existing-root', path: 'A.md', line: 7, navigationOrigin: next },
    });
    const layout = useF307ExperienceWorkbenchStore.getState().layout;
    expect(layout.surfaces).toHaveLength(1);
    expect(layout.surfaces[0]?.navigationOrigin).toEqual(next);
    expect(layout.activeSurfaceId).toBe(file.id);
    expect(layout.previewSurfaceId).toBeNull();
  });

  it('names a generic image tab from its exact original message instead of repeating the generic title', async () => {
    writeShellPresentation('v2');
    const previous = useChatStore.getState();
    const timestamp = Date.UTC(2026, 9, 6, 18, 42);
    const source = {
      kind: 'message' as const,
      threadId: 'thread-a',
      messageId: 'exact-image-source',
      messageRevision: '1',
      expectedUrl: '/uploads/exact-image.png',
      item: { kind: 'content-block' as const, index: 0 },
    };
    useChatStore.setState({
      currentThreadId: 'thread-a',
      messages: [{ id: source.messageId, type: 'assistant', content: 'original image', catId: 'codex-sol', timestamp }],
    });
    try {
      await renderWorkbench({
        revision: 1,
        threadId: 'thread-a',
        disposition: 'preview',
        target: {
          kind: 'publication',
          contentRef: `prepared-media:${'f'.repeat(64)}`,
          ownerRevision: 1,
          title: 'generated image',
          messagePublicationSource: source,
        },
      });
      const title = useF307ExperienceWorkbenchStore.getState().layout.surfaces[0]?.title;
      const clock = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      expect(title).toMatch(/^图片 · .+/);
      expect(title?.endsWith(clock)).toBe(true);
      expect(title).not.toContain('generated image');
    } finally {
      useChatStore.setState({ currentThreadId: previous.currentThreadId, messages: previous.messages });
    }
  });

  it('opens and revisits a pinned publication without stealing main attention, and returns to its exact message', async () => {
    const contentRef = `prepared-media:${'e'.repeat(64)}`;
    const target = {
      kind: 'publication' as const,
      contentRef,
      ownerRevision: 1,
      title: '晨光',
      navigationOrigin: { kind: 'chat-file-link' as const, threadId: 'source-thread', messageId: 'source-message' },
    };
    const back = vi.fn();
    await renderWorkbench({ revision: 1, threadId: 'thread-a', target }, vi.fn(), { onReturnToChatMessage: back });
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
    await renderWorkbench({ revision: 2, threadId: 'thread-a', target: { ...target, ownerRevision: 2 } }, vi.fn(), {
      onReturnToChatMessage: back,
    });
    const { layout } = useF307ExperienceWorkbenchStore.getState();
    expect(layout.surfaces).toHaveLength(1);
    expect(JSON.parse(layout.surfaces[0]!.ownerStateRef.key).ownerRevision).toBe(2);
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`[data-testid="return-origin-publication:${contentRef}"]`)!.click(),
    );
    expect(back).toHaveBeenCalledWith({ threadId: 'source-thread', messageId: 'source-message' });
  });

  it('returns a file-tree collaboration close to the F063 files owner', async () => {
    const surface = { ...FILE_SURFACE, navigationOrigin: { kind: 'file-tree' as const } };
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([surface]),
      hydrated: true,
      mainAreaAttentionSurfaceId: surface.id,
    });
    await renderWorkbench();

    await act(async () => {
      (container.querySelector(`[data-testid="return-origin-${surface.id}"]`) as HTMLButtonElement).click();
    });
    expect(useF307ExperienceWorkbenchStore.getState().layout.activeSurfaceId).toBe(
      'workspace:surface:files:worktree-a',
    );
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
  });

  it('moves an ordinary Changes file open to the new owner while keeping focus mode', async () => {
    const changes = createWorkspaceDestinationSurface(
      { kind: 'surface', id: 'changes', label: '变更', description: 'Diff', searchTerms: 'changes' },
      'thread-a',
      'worktree-a',
    );
    expect(changes).not.toBeNull();
    if (!changes) return;
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([changes]),
      focusSurfaceId: changes.id,
    });
    await renderWorkbench();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="open-changes-file"]')?.click());
    expect(useF307ExperienceWorkbenchStore.getState().layout.activeSurfaceId).toBe(FILE_SURFACE.id);
    expect(useF307ExperienceWorkbenchStore.getState().focusSurfaceId).toBe(FILE_SURFACE.id);
  });

  it('keeps focus on the retained permanent file when an owner opens the same file as a preview', async () => {
    writeShellPresentation('v2');
    const changes = createWorkspaceDestinationSurface(
      { kind: 'surface', id: 'changes', label: '变更', description: 'Diff', searchTerms: 'changes' },
      'thread-a',
      'worktree-a',
    )!;
    useF307ExperienceWorkbenchStore.setState({
      layout: {
        ...createInitialWorkbenchState([FILE_SURFACE, changes]),
        activeSurfaceId: changes.id,
        pinnedSurfaceIds: [FILE_SURFACE.id],
      },
      focusSurfaceId: changes.id,
    });
    await renderWorkbench();
    const owner = container.querySelector(`[data-owner-surface-id="${FILE_SURFACE.id}"]`);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="open-changes-file"]')!.click());
    expect(useF307ExperienceWorkbenchStore.getState().layout.activeSurfaceId).toBe(FILE_SURFACE.id);
    expect(useF307ExperienceWorkbenchStore.getState().focusSurfaceId).toBe(FILE_SURFACE.id);
    expect(container.querySelector(`[data-owner-surface-id="${FILE_SURFACE.id}"]`)).toBe(owner);
    expect(owner?.getAttribute('data-focus-mode')).toBe('true');
  });

  it('keeps focus mode when returning an ordinary file to its original tree', async () => {
    const surface = { ...FILE_SURFACE, navigationOrigin: { kind: 'file-tree' as const } };
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([surface]),
      focusSurfaceId: surface.id,
    });
    await renderWorkbench();
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`[data-testid="return-origin-${surface.id}"]`)?.click(),
    );
    expect(useF307ExperienceWorkbenchStore.getState().layout.activeSurfaceId).toBe(
      'workspace:surface:files:worktree-a',
    );
    expect(useF307ExperienceWorkbenchStore.getState().focusSurfaceId).toBe('workspace:surface:files:worktree-a');
  });

  it('returns a Changes-opened canonical file to the original listed Changes owner without replacing its DOM', async () => {
    const changes = createWorkspaceDestinationSurface(
      { kind: 'surface', id: 'changes', label: '变更', description: 'Diff', searchTerms: 'changes' },
      'thread-a',
      'listed-worktree',
    );
    expect(changes).not.toBeNull();
    if (!changes) return;
    const file = {
      ...FILE_SURFACE,
      navigationOrigin: { kind: 'workspace-changes' as const, worktreeId: 'listed-worktree', threadId: 'thread-a' },
    };
    useF307ExperienceWorkbenchStore.setState({
      layout: { ...createInitialWorkbenchState([changes, file]), activeSurfaceId: file.id },
      focusSurfaceId: file.id,
    });
    await renderWorkbench();
    const originalOwner = container.querySelector(`[data-owner-surface-id="${changes.id}"]`);
    expect(originalOwner).not.toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`[data-testid="return-origin-${file.id}"]`)?.click(),
    );
    const state = useF307ExperienceWorkbenchStore.getState();
    expect(state.layout.activeSurfaceId).toBe(changes.id);
    expect(state.focusSurfaceId).toBe(changes.id);
    expect(resolveChangesTarget(state.layout.surfaces.find((surface) => surface.id === changes.id)!)).toEqual({
      worktreeId: 'listed-worktree',
      threadId: 'thread-a',
    });
    expect(container.querySelector(`[data-owner-surface-id="${changes.id}"]`)).toBe(originalOwner);
  });

  it('returns a Home-search collaboration close to the original query', async () => {
    const onRestoreWorkspaceSearch = vi.fn();
    const surface = {
      ...FILE_SURFACE,
      navigationOrigin: { kind: 'workspace-home-search' as const, query: 'canonical owner', viewportOffsetPx: 84 },
    };
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([surface]),
      hydrated: true,
      mainAreaAttentionSurfaceId: surface.id,
    });
    await renderWorkbench(undefined, undefined, { onRestoreWorkspaceSearch });

    await act(async () => {
      (container.querySelector(`[data-testid="return-origin-${surface.id}"]`) as HTMLButtonElement).click();
    });
    expect(onRestoreWorkspaceSearch).toHaveBeenCalledWith('canonical owner');
    const home = container.querySelector<HTMLElement>('[data-testid="f307-workspace-home-page"]');
    expect(home?.dataset.workspaceSearchQuery).toBe('canonical owner');
    expect(home?.dataset.searchOffset).toBe('84');
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
  });

  it('returns a chat-link collaboration close to the exact message coordinate', async () => {
    const onReturnToChatMessage = vi.fn();
    const surface = {
      ...FILE_SURFACE,
      navigationOrigin: { kind: 'chat-file-link' as const, threadId: 'thread-origin', messageId: 'message-origin' },
    };
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([surface]),
      hydrated: true,
      mainAreaAttentionSurfaceId: surface.id,
    });
    await renderWorkbench(undefined, undefined, { onReturnToChatMessage });

    await act(async () => {
      (container.querySelector(`[data-testid="return-origin-${surface.id}"]`) as HTMLButtonElement).click();
    });
    expect(onReturnToChatMessage).toHaveBeenCalledWith({ threadId: 'thread-origin', messageId: 'message-origin' });
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
  });

  it('returns a meeting-opened file to the same thread transcript panel, exiting attention without any notice', async () => {
    // C 3480: the minimal contract — a same-thread meeting origin restores that thread's docked transcript panel.
    useChatStore.setState({ currentThreadId: 'thread-a', rightPanelMode: 'status' });
    const origin = { kind: 'meeting-transcript' as const, threadId: 'thread-a' };
    const surface = { ...FILE_SURFACE, navigationOrigin: origin };
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([surface]),
      hydrated: true,
      mainAreaAttentionSurfaceId: surface.id,
    });
    await renderWorkbench();

    await act(async () => {
      (container.querySelector(`[data-testid="return-origin-${surface.id}"]`) as HTMLButtonElement).click();
    });

    expect(useChatStore.getState().rightPanelMode).toBe('transcript');
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('a meeting origin from another thread only notices the return source and never switches the panel', async () => {
    // C 3480: wrong-thread fail-closed — no panel switch, no silent success, the original notice points back.
    useChatStore.setState({ currentThreadId: 'thread-a', rightPanelMode: 'status' });
    const surface = {
      ...FILE_SURFACE,
      navigationOrigin: { kind: 'meeting-transcript' as const, threadId: 'thread-b' },
    };
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([surface]),
      hydrated: true,
      mainAreaAttentionSurfaceId: surface.id,
    });
    await renderWorkbench();

    await act(async () => {
      (container.querySelector(`[data-testid="return-origin-${surface.id}"]`) as HTMLButtonElement).click();
    });

    expect(useChatStore.getState().rightPanelMode).toBe('status');
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ type: 'info' });
    expect(toasts[0]?.message).toContain('来源对话');
    // The person stays exactly where they were; attention is not silently consumed either.
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBe(surface.id);
  });

  it('returns a relative document link through the same owner host at its original line', async () => {
    const surface = {
      ...FILE_SURFACE,
      navigationOrigin: {
        kind: 'workspace-document' as const,
        worktreeId: 'original-worktree',
        path: 'docs/original.md',
        line: 17,
      },
    };
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([surface]),
      hydrated: true,
      mainAreaAttentionSurfaceId: surface.id,
    });
    await renderWorkbench();
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`[data-testid="return-origin-${surface.id}"]`)?.click(),
    );
    const state = useF307ExperienceWorkbenchStore.getState();
    const active = state.layout.surfaces.find((item) => item.id === state.layout.activeSurfaceId)!;
    expect(resolveFileTarget(active)).toEqual({
      worktreeId: 'original-worktree',
      path: 'docs/original.md',
      scrollToLine: 17,
    });
    expect(state.mainAreaAttentionSurfaceId).toBeNull();
  });

  it.each([
    'eval',
    'status',
  ] as const)('returns a card-opened file to the actual %s owner in the right Workspace', async (destination) => {
    window.history.replaceState({}, '', '/thread/thread-a');
    const origin = {
      kind: 'workspace-card' as const,
      threadId: 'thread-a',
      destination,
      anchorId: 'original-card',
      viewportOffsetPx: 34,
    };
    const surface = { ...FILE_SURFACE, navigationOrigin: origin };
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([surface]),
      hydrated: true,
      mainAreaAttentionSurfaceId: surface.id,
    });
    await renderWorkbench();
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`[data-testid="return-origin-${surface.id}"]`)?.click(),
    );
    const state = useF307ExperienceWorkbenchStore.getState();
    const active = state.layout.surfaces.find((item) => item.id === state.layout.activeSurfaceId)!;
    expect(active.objectRef.id).toBe(destination === 'eval' ? 'mode:eval' : 'host:status');
    expect(JSON.parse(new URL(window.location.href).searchParams.get('fileReturn')!)).toEqual({
      anchorId: 'original-card',
      viewportOffsetPx: 34,
      threadId: 'thread-a',
    });
    expect(state.mainAreaAttentionSurfaceId).toBeNull();
  });

  it('returns a settings-opened file to the original section with a recoverable card coordinate', async () => {
    const origin = {
      kind: 'settings' as const,
      href: '/settings?s=ops&obs=eval',
      anchorId: 'eval:original',
      viewportOffsetPx: 34,
    };
    const surface = { ...FILE_SURFACE, navigationOrigin: origin };
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([surface]),
      hydrated: true,
      mainAreaAttentionSurfaceId: surface.id,
    });
    await renderWorkbench();
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`[data-testid="return-origin-${surface.id}"]`)?.click(),
    );
    const url = new URL(mocks.openAppRoute.mock.lastCall![0], window.location.origin);
    expect(url.pathname).toBe('/settings');
    expect(url.searchParams.get('obs')).toBe('eval');
    expect(JSON.parse(url.searchParams.get('fileReturn')!)).toEqual({
      anchorId: 'eval:original',
      viewportOffsetPx: 34,
    });
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
  });

  it('opens an exact Team subject only for an explicit navigation request', async () => {
    const onConsumed = vi.fn();
    await renderWorkbench(
      {
        revision: 1,
        threadId: 'thread-a',
        target: { kind: 'team', subject: { type: 'cat', id: 'codex-sol' } },
      },
      onConsumed,
    );

    const { layout } = useF307ExperienceWorkbenchStore.getState();
    expect(layout.activeSurfaceId).toBe('workspace:mode:team:thread-a');
    expect(layout.surfaces[0]).toMatchObject({
      ownerStateRef: { owner: 'f293-routing-context', key: 'thread-a' },
      resultTargetRef: {
        owner: 'f293-routing-context',
        key: encodeTeamWorkspaceSubject({ type: 'cat', id: 'codex-sol' }),
      },
    });
    expect(container.querySelector('[data-testid="f307-workspace-home-page"]')).toBeNull();
    expect(onConsumed).toHaveBeenCalledWith(1);
  });

  it('opens the evolution home itself from Settings, then consumes its request', async () => {
    const onConsumed = vi.fn();
    await renderWorkbench({ revision: 1, threadId: 'thread-a', target: { kind: 'evolution-home' } }, onConsumed);
    const state = useF307ExperienceWorkbenchStore.getState();
    expect(state.layout.activeSurfaceId).toBe('workspace:capability-evolution');
    expect(
      state.layout.surfaces.find((surface) => surface.id === state.layout.activeSurfaceId)?.resultTargetRef?.key,
    ).toBe('thread-a');
    expect(onConsumed).toHaveBeenCalledWith(1);
  });

  it('reveals an evolution home request when the conversation foreground starts at Home', async () => {
    writeShellPresentation('v2');
    useChatStore.setState({
      currentThreadId: 'thread-a',
      workspaceForegroundSurfaceId: null,
      workspaceWorktreeId: null,
    });
    function Host() {
      const foregroundSurfaceId = useChatStore((state) => state.workspaceForegroundSurfaceId);
      return (
        <F307ExperienceWorkbench
          threadId="thread-a"
          foregroundSurfaceId={foregroundSurfaceId}
          artifactWorkHostAvailable
          onSelectDevSurface={() => undefined}
          worktreeId={null}
          openFilePath={null}
          preview={{ path: '/' }}
          workspaceOpenRequest={{ revision: 1, threadId: 'thread-a', target: { kind: 'evolution-home' } }}
          onOpenAppRoute={mocks.openAppRoute}
        />
      );
    }
    await act(async () => root.render(<Host />));
    expect(useChatStore.getState().workspaceForegroundSurfaceId).toBe('workspace:capability-evolution');
    expect(container.querySelector('[data-workbench-focus="surface"]')).not.toBeNull();
  });

  it('keeps a return request queued while the global page still parks Chat at default', async () => {
    useChatStore.setState({ currentThreadId: 'default', workspaceForegroundSurfaceId: null });
    const onConsumed = vi.fn();
    await renderWorkbench({ revision: 1, threadId: 'thread-a', target: { kind: 'evolution-home' } }, onConsumed);
    expect(onConsumed).not.toHaveBeenCalled();
    await act(async () => useChatStore.getState().setCurrentThread('thread-a'));
    expect(onConsumed).toHaveBeenCalledWith(1);
    expect(useChatStore.getState().workspaceForegroundSurfaceId).toBe('workspace:capability-evolution');
  });

  it('opens an exact Program source through the existing owner and main attention host', async () => {
    const programId = 'evolution-program:bcc336788a7df9d6075b1efb4c0a7e68';
    const onConsumed = vi.fn();
    await renderWorkbench(
      { revision: 1, threadId: 'thread-a', target: { kind: 'evolution-program', programId } },
      onConsumed,
    );
    const state = useF307ExperienceWorkbenchStore.getState();
    expect(state.layout.activeSurfaceId).toBe(`evolution-program:${programId}`);
    expect(state.mainAreaAttentionSurfaceId).toBe(state.layout.activeSurfaceId);
    expect(state.mainAreaAttentionPresentation).toEqual({
      kind: 'chat-workspace',
      threadId: 'thread-a',
      chatBasis: 30,
    });
    expect(onConsumed).toHaveBeenCalledWith(1);
  });

  it.each([true, false])('opens explicit Schedule with original attention only on desktop=%s', async (desktop) => {
    mocks.isDesktop = desktop;
    const onConsumed = vi.fn();
    const request: WorkspaceOpenRequest = {
      revision: 1,
      threadId: 'thread-a',
      target: { kind: 'mode', mode: 'product-schedule' },
    };
    await renderWorkbench(request, onConsumed);
    const state = useF307ExperienceWorkbenchStore.getState();
    expect(state.layout.activeSurfaceId).toBe('workspace:mode:product-schedule');
    expect(state.mainAreaAttentionSurfaceId).toBe(desktop ? state.layout.activeSurfaceId : null);
    expect(onConsumed).toHaveBeenCalledWith(1);
    act(() => state.exitMainAreaAttention());
    await renderWorkbench(request, onConsumed);
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
    expect(onConsumed).toHaveBeenCalledTimes(1);
  });

  it('does not widen a passively restored Schedule without a new explicit input', async () => {
    const schedule = createWorkspaceModeSurface('product-schedule', 'thread-a');
    useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([schedule]) });
    await renderWorkbench();
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
  });

  it.each([
    ['desktop', true],
    ['390px', false],
  ])('renders canonical Home immediately for an initially empty %s workbench', async (_viewport, isDesktop) => {
    mocks.isDesktop = isDesktop;

    await renderWorkbench();

    expect(container.querySelector('[data-testid="f307-workspace-home-page"]')).not.toBeNull();
    const workbench = container.querySelector<HTMLElement>('[data-testid="f307-experience-workbench"]');
    expect(workbench?.dataset.workbenchFocus).toBe('home');
    expect(workbench?.dataset.surfaceCount).toBe('0');
    expect(workbench?.dataset.zeroTopologyContract).toBe('canonical-home');
    expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces).toEqual([]);
    expect(container.querySelector('[data-testid="f307-tab-actions"]')).toBeNull();
  });

  it('does not attest the transient empty default before hydrating a valid persisted surface', async () => {
    window.localStorage.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify(createInitialWorkbenchState([FILE_SURFACE])));
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState(),
      hydrated: false,
      hydrate: vi.fn(),
    });

    await renderWorkbench();

    const workbench = container.querySelector<HTMLElement>('[data-testid="f307-experience-workbench"]');
    expect(workbench?.dataset.layoutHydrated).toBe('false');
    expect(workbench?.dataset.surfaceCount).toBe('0');
    expect(workbench?.dataset.zeroTopologyContract).toBe('pending-hydration');

    await act(async () => hydrateWorkbench());

    expect(workbench?.dataset.layoutHydrated).toBe('true');
    expect(workbench?.dataset.surfaceCount).toBe('1');
    expect(workbench?.dataset.workbenchFocus).toBe('surface');
    expect(workbench?.dataset.zeroTopologyContract).toBe('not-applicable');
    expect(container.querySelector('[data-testid="f307-workspace-home-page"]')).toBeNull();
  });

  it('does not turn project-wide live executions into persistent Workbench activity', async () => {
    window.localStorage.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify(createInitialWorkbenchState([FILE_SURFACE])));
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState(),
      hydrated: false,
      hydrate: hydrateWorkbench,
    });
    mocks.executionsByKey = {
      'live_invocation:inv-background': {
        executionId: 'inv-background',
        threadId: 'thread-background',
        threadTitle: 'Background work',
        catId: 'codex',
        kind: 'live_invocation',
        startedAt: 100,
        cancelability: {
          state: 'cancelable',
          target: {
            kind: 'live_invocation',
            threadId: 'thread-background',
            catId: 'codex',
            executionId: 'inv-background',
          },
        },
      },
    };

    await renderWorkbench();

    const state = useF307ExperienceWorkbenchStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.layout.surfaces).toEqual([FILE_SURFACE]);
    expect(state.layout.activeSurfaceId).toBe(FILE_SURFACE.id);
    expect(state.layout.activity).toEqual([]);

    const persisted = JSON.parse(window.localStorage.getItem(WORKBENCH_STORAGE_KEY) ?? 'null');
    expect(persisted.surfaces).toEqual([FILE_SURFACE]);
    expect(persisted.activeSurfaceId).toBe(FILE_SURFACE.id);
    expect(persisted.activity).toEqual([]);
    expect(
      container.querySelector<HTMLElement>('[data-testid="f307-experience-workbench"]')?.dataset.activeSurface,
    ).toBe(FILE_SURFACE.id);
  });

  it('keeps a fixed control rail outside the scrolling tabs and bulk-detaches only other unpinned views', async () => {
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([FILE_SURFACE, AGENT_RUN_SURFACE]),
      hydrated: true,
    });
    await renderWorkbench();

    const workbench = container.querySelector<HTMLElement>('[data-testid="f307-experience-workbench"]');
    const strip = container.querySelector<HTMLElement>('[data-testid="f307-tab-strip"]');
    const controls = container.querySelector<HTMLElement>('[data-testid="f307-control-rail"]');
    const addSurface = container.querySelector<HTMLButtonElement>('[data-testid="f307-add-surface"]');
    expect(strip?.contains(addSurface ?? null)).toBe(false);
    expect(controls?.contains(addSurface ?? null)).toBe(true);
    expect(workbench?.dataset.workbenchFocus).toBe('surface');
    expect(workbench?.dataset.surfaceCount).toBe('2');

    const manage = container.querySelector<HTMLButtonElement>('[data-testid="f307-manage-surfaces"]');
    await act(async () => manage?.click());
    const closeOthers = container.querySelector<HTMLButtonElement>('[data-testid="f307-close-other-surfaces"]');
    expect(closeOthers?.textContent).toContain('收起其他未固定页面');
    await act(async () => closeOthers?.click());

    expect(useF307ExperienceWorkbenchStore.getState().layout).toMatchObject({
      surfaces: [FILE_SURFACE],
      activeSurfaceId: FILE_SURFACE.id,
      recentlyClosed: [AGENT_RUN_SURFACE],
    });

    await act(async () => addSurface?.click());

    expect(container.querySelector('[data-testid="f307-workspace-home-page"]')).not.toBeNull();
    expect(workbench?.dataset.workbenchFocus).toBe('home');
    expect(useF307ExperienceWorkbenchStore.getState().layout).toMatchObject({
      surfaces: [FILE_SURFACE],
      activeSurfaceId: FILE_SURFACE.id,
      split: null,
    });
  });

  it('focuses the exact active surface without mutating its working set, split, or sidecar', async () => {
    const split = {
      primarySurfaceId: FILE_SURFACE.id,
      secondarySurfaceId: AGENT_RUN_SURFACE.id,
    };
    const layout = {
      ...createInitialWorkbenchState([FILE_SURFACE, AGENT_RUN_SURFACE]),
      activeSurfaceId: FILE_SURFACE.id,
      split,
      sidecar: BROWSER_SURFACE,
    };
    useF307ExperienceWorkbenchStore.setState({
      layout,
      hydrated: true,
      focusSurfaceId: null,
    });
    await renderWorkbench();

    const workbench = container.querySelector<HTMLElement>('[data-testid="f307-experience-workbench"]');
    const focus = container.querySelector<HTMLButtonElement>(
      `[data-surface-id="${FILE_SURFACE.id}"] [data-testid="workspace-focus-enter"]`,
    );
    expect(focus).not.toBeNull();
    await act(async () => focus?.click());

    expect(workbench?.dataset.focusSurface).toBe(FILE_SURFACE.id);
    expect(container.querySelector('[data-testid="f307-tab-actions"]')).toBeNull();
    expect(container.querySelector('[data-testid="workbench-sidecar"]')?.getAttribute('data-visible')).toBe('false');
    expect(container.querySelector('[data-testid="owner-surface-code"]')?.parentElement?.dataset.visible).toBe('true');
    expect(container.querySelector('[data-testid="owner-surface-agent-run"]')?.parentElement?.dataset.visible).toBe(
      'false',
    );
    expect(container.querySelector('[data-testid="owner-surface-code"]')?.getAttribute('data-focus-mode')).toBe('true');
    expect(useF307ExperienceWorkbenchStore.getState().layout).toEqual(layout);

    const exit = container.querySelector<HTMLButtonElement>('[data-testid="workspace-focus-exit"]');
    expect(exit).not.toBeNull();
    await act(async () => exit?.click());

    expect(workbench?.dataset.focusSurface).toBe('');
    expect(container.querySelector('[data-testid="f307-tab-actions"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="workbench-sidecar"]')?.getAttribute('data-visible')).toBe('true');
    expect(container.querySelector('[data-testid="owner-surface-agent-run"]')?.parentElement?.dataset.visible).toBe(
      'true',
    );
    expect(useF307ExperienceWorkbenchStore.getState().layout).toEqual(layout);
  });

  it('exposes an explicit split exit that preserves both hosted views', async () => {
    const splitLayout = {
      ...createInitialWorkbenchState([FILE_SURFACE, AGENT_RUN_SURFACE]),
      split: {
        primarySurfaceId: FILE_SURFACE.id,
        secondarySurfaceId: AGENT_RUN_SURFACE.id,
      },
    };
    useF307ExperienceWorkbenchStore.setState({ layout: splitLayout, hydrated: true });
    await renderWorkbench();

    const exitSplit = container.querySelector<HTMLButtonElement>('[data-testid="f307-exit-split"]');
    expect(exitSplit?.getAttribute('aria-label')).toBe('退出分屏');
    await act(async () => exitSplit?.click());

    expect(useF307ExperienceWorkbenchStore.getState().layout).toMatchObject({
      surfaces: [FILE_SURFACE, AGENT_RUN_SURFACE],
      split: null,
    });
  });

  it.each([
    ['File', FILE_SURFACE, 'code'],
    ['Browser', BROWSER_SURFACE, 'browser'],
    ['Terminal', TERMINAL_SURFACE, 'terminal'],
    ['Agent Run', AGENT_RUN_SURFACE, 'agent-run'],
    ['Program', PROGRAM_SURFACE, 'evolution-program'],
  ] as const)('promotes an active %s tab to the main area and treats close as return', async (_kind, surface, type) => {
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([surface]),
      hydrated: true,
      mainAreaAttentionSurfaceId: null,
    });
    await renderWorkbench();

    const promote = container.querySelector<HTMLButtonElement>('[data-testid="f307-enter-main-area"]');
    expect(promote?.getAttribute('aria-label')).toBe(`在主区打开 ${surface.title}`);
    await act(async () => promote?.click());

    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBe(surface.id);
    expect(
      container.querySelector<HTMLElement>('[data-testid="f307-experience-workbench"]')?.dataset.mainAreaAttention,
    ).toBe(surface.id);

    const close = container.querySelector<HTMLButtonElement>(`[data-testid="f307-close-${type}"]`);
    expect(close?.getAttribute('aria-label')).toBe(`返回侧栏 ${surface.title}`);
    await act(async () => close?.click());

    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
    expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces).toEqual([surface]);
  });

  it.each([
    true,
    false,
  ])('preserves main-area attention only on desktop when remounting (desktop=%s)', async (desktop) => {
    mocks.useNativeViewport = true;
    vi.stubGlobal('matchMedia', () => ({ matches: desktop, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([FILE_SURFACE]),
      hydrated: true,
      mainAreaAttentionSurfaceId: FILE_SURFACE.id,
    });
    await renderWorkbench();
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBe(
      desktop ? FILE_SURFACE.id : null,
    );
  });

  it('projects only the exact active tab in main-area attention without changing the saved split', async () => {
    const split = {
      primarySurfaceId: FILE_SURFACE.id,
      secondarySurfaceId: AGENT_RUN_SURFACE.id,
    };
    useF307ExperienceWorkbenchStore.setState({
      layout: {
        ...createInitialWorkbenchState([FILE_SURFACE, AGENT_RUN_SURFACE]),
        split,
        sidecar: BROWSER_SURFACE,
      },
      hydrated: true,
      mainAreaAttentionSurfaceId: null,
    });
    await renderWorkbench();

    const filePane = container.querySelector('[data-testid="owner-surface-code"]')?.parentElement;
    const agentRunPane = container.querySelector('[data-testid="owner-surface-agent-run"]')?.parentElement;
    const sidecar = container.querySelector('[data-testid="workbench-sidecar"]');
    expect(filePane?.getAttribute('data-visible')).toBe('true');
    expect(agentRunPane?.getAttribute('data-visible')).toBe('true');
    expect(sidecar?.getAttribute('data-visible')).toBe('true');

    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="f307-enter-main-area"]')?.click());

    expect(filePane?.getAttribute('data-visible')).toBe('true');
    expect(agentRunPane?.getAttribute('data-visible')).toBe('false');
    expect(sidecar?.getAttribute('data-visible')).toBe('false');
    expect(useF307ExperienceWorkbenchStore.getState().layout.split).toEqual(split);
    expect(useF307ExperienceWorkbenchStore.getState().layout.sidecar).toEqual(BROWSER_SURFACE);

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="f307-return-from-main-area"]')?.click(),
    );

    expect(filePane?.getAttribute('data-visible')).toBe('true');
    expect(agentRunPane?.getAttribute('data-visible')).toBe('true');
    expect(sidecar?.getAttribute('data-visible')).toBe('true');
    expect(useF307ExperienceWorkbenchStore.getState().layout.split).toEqual(split);
    expect(useF307ExperienceWorkbenchStore.getState().layout.sidecar).toEqual(BROWSER_SURFACE);
  });

  it('unmounts a closed replay while keeping its descriptor restorable', async () => {
    const surface = createThreadReplaySurface('thread-a');
    if (!surface) throw new Error('missing canonical replay');
    useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([surface]), hydrated: true });
    await renderWorkbench();
    expect(container.querySelector('[data-testid="owner-surface-thread-replay"]')).not.toBeNull();
    await act(async () =>
      useF307ExperienceWorkbenchStore.getState().dispatch({
        type: 'close-surface',
        surfaceId: surface.id,
        entitlement: { kind: 'user', reason: 'close-button' },
      }),
    );
    expect(useF307ExperienceWorkbenchStore.getState().layout.recentlyClosed).toEqual([surface]);
    expect(container.querySelector('[data-testid="owner-surface-thread-replay"]')).toBeNull();
  });

  it('keeps every owner mounted while exposing physical visibility only to the active surface', async () => {
    const layout = {
      ...createInitialWorkbenchState([FILE_SURFACE, PROGRAM_SURFACE]),
      activeSurfaceId: FILE_SURFACE.id,
      recentlyClosed: [BROWSER_SURFACE],
    };
    useF307ExperienceWorkbenchStore.setState({ layout, hydrated: true });
    await renderWorkbench();

    const file = container.querySelector<HTMLElement>(`[data-owner-surface-id="${FILE_SURFACE.id}"]`);
    const program = container.querySelector<HTMLElement>(`[data-owner-surface-id="${PROGRAM_SURFACE.id}"]`);
    const browser = container.querySelector<HTMLElement>(`[data-owner-surface-id="${BROWSER_SURFACE.id}"]`);
    expect(file?.dataset.surfaceVisible).toBe('true');
    expect(program?.dataset.surfaceVisible).toBe('false');
    expect(browser?.dataset.surfaceVisible).toBe('false');

    mocks.workbenchVisible = false;
    await renderWorkbench();

    expect(container.querySelector(`[data-owner-surface-id="${FILE_SURFACE.id}"]`)).toBe(file);
    expect(container.querySelector(`[data-owner-surface-id="${PROGRAM_SURFACE.id}"]`)).toBe(program);
    expect(file?.dataset.surfaceVisible).toBe('false');
    expect(program?.dataset.surfaceVisible).toBe('false');
    expect(browser?.dataset.surfaceVisible).toBe('false');

    mocks.workbenchVisible = true;
    await renderWorkbench();
    await act(async () => {
      useF307ExperienceWorkbenchStore.getState().dispatch({
        type: 'activate-surface',
        surfaceId: PROGRAM_SURFACE.id,
        entitlement: { kind: 'user', reason: 'surface-tab' },
      });
    });

    expect(file?.dataset.surfaceVisible).toBe('false');
    expect(program?.dataset.surfaceVisible).toBe('true');
    expect(browser?.dataset.surfaceVisible).toBe('false');
  });

  it.each([
    'desktop',
    'mobile',
  ] as const)('keeps the same Schedule owner and local week through %s publication returns', async (presentation) => {
    mocks.isDesktop = presentation === 'desktop';
    const schedule = createWorkspaceModeSurface('product-schedule', 'thread-a');
    const selected = createProductScheduleReturnSurface(schedule, 'task:work:calendar-task');
    if (!selected) throw new Error('The original Schedule return factory must accept its exact item');
    useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([schedule]), hydrated: true });
    await renderWorkbench();
    const owner = container.querySelector<HTMLElement>(`[data-owner-surface-id="${schedule.id}"]`);
    if (!owner) throw new Error('The original owner must be mounted');
    const nextWeek = owner.querySelector<HTMLButtonElement>(`[data-testid="owner-week-${schedule.id}"]`);
    if (!nextWeek) throw new Error('The owner must expose its local view');
    await act(async () => nextWeek.click());
    owner.scrollTop = 218;
    for (let attempt = 0; attempt < 2; attempt++) {
      await act(async () =>
        useF307ExperienceWorkbenchStore.getState().dispatch({
          type: 'open-artifact-with-return',
          artifact: ARTIFACT_SURFACE,
          returnSurface: selected,
          presentation,
          entitlement: { kind: 'user', reason: 'workspace-home-selection' },
        }),
      );
      expect(container.querySelectorAll(`[data-owner-surface-id="${schedule.id}"]`)).toHaveLength(1);
      expect(container.querySelector(`[data-owner-surface-id="${schedule.id}"]`)).toBe(owner);
      expect(nextWeek.textContent).toBe('12–18');
      expect(owner.scrollTop).toBe(218);
      await act(async () =>
        useF307ExperienceWorkbenchStore.getState().dispatch({
          type: 'close-artifact-to-return',
          artifactSurfaceId: ARTIFACT_SURFACE.id,
          entitlement: { kind: 'user', reason: 'return-origin' },
        }),
      );
      expect(container.querySelector(`[data-owner-surface-id="${schedule.id}"]`)).toBe(owner);
      expect(nextWeek.textContent).toBe('12–18');
      expect(owner.scrollTop).toBe(218);
      expect(useF307ExperienceWorkbenchStore.getState().layout.activeSurfaceId).toBe(schedule.id);
    }
  });

  it('labels an Agent Run tab as running work and describes close as removing only its Workspace view', async () => {
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([AGENT_RUN_SURFACE]),
      hydrated: true,
    });
    await renderWorkbench();

    const tab = container.querySelector<HTMLButtonElement>('[data-testid="f307-tab-agent-run"]');
    expect(tab?.textContent).toContain('运行');
    expect(tab?.textContent).toContain('clowder-ai#1408');
    expect(container.querySelector('[data-testid="f307-tab-kind-agent-run"]')?.textContent).toBe('运行');
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="f307-close-agent-run"]')?.getAttribute('aria-label'),
    ).toBe('从工作台收起 clowder-ai#1408: 官网与文档发布边界（不会停止任务）');
  });

  it('returns Home after detaching the final surface and restores it from Home without synthetic topology', async () => {
    useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([FILE_SURFACE]), hydrated: true });
    await renderWorkbench();

    expect(container.querySelector('[data-testid="f307-workspace-home-page"]')).toBeNull();
    const close = container.querySelector<HTMLButtonElement>('[data-testid="f307-close-code"]');
    await act(async () => close?.click());

    expect(container.querySelector('[data-testid="f307-workspace-home-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="f307-recently-closed"]')).not.toBeNull();
    expect(
      container.querySelector<HTMLElement>('[data-testid="f307-experience-workbench"]')?.dataset.zeroTopologyContract,
    ).toBe('canonical-home');
    expect(useF307ExperienceWorkbenchStore.getState().layout).toMatchObject({
      surfaces: [],
      activeSurfaceId: null,
      recentlyClosed: [FILE_SURFACE],
    });

    const recentlyClosedToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="f307-recently-closed-toggle"]',
    );
    expect(recentlyClosedToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(recentlyClosedToggle?.textContent).toContain('最近关闭 1');
    expect(container.querySelector('[data-testid="f307-restore-code"]')).toBeNull();

    await act(async () => recentlyClosedToggle?.click());

    expect(recentlyClosedToggle?.getAttribute('aria-expanded')).toBe('true');
    const restore = container.querySelector<HTMLButtonElement>('[data-testid="f307-restore-code"]');
    await act(async () => restore?.click());

    expect(container.querySelector('[data-testid="f307-workspace-home-page"]')).toBeNull();
    expect(useF307ExperienceWorkbenchStore.getState().layout).toMatchObject({
      surfaces: [FILE_SURFACE],
      activeSurfaceId: FILE_SURFACE.id,
      recentlyClosed: [],
    });
  });

  it('updates recently closed controls with the v2 language without losing expansion or restore identity', async () => {
    writeShellPresentation('v2');
    writeShellLanguage('en');
    useF307ExperienceWorkbenchStore.setState({
      layout: { ...createInitialWorkbenchState(), recentlyClosed: [FILE_SURFACE] },
      hydrated: true,
    });
    await renderWorkbench();
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="f307-recently-closed-toggle"]')!;
    expect(toggle.textContent).toBe('Recently closed 1');
    expect(toggle.getAttribute('aria-label')).toBe('Expand recently closed Workspace pages');
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-label')).toBe('Collapse recently closed Workspace pages');
    const restore = container.querySelector<HTMLButtonElement>('[data-testid="f307-restore-code"]')!;
    expect(restore.textContent).toBe(`Restore ${FILE_SURFACE.title}`);

    await act(async () => writeShellLanguage('zh'));
    expect(container.querySelector('[data-testid="f307-recently-closed-toggle"]')).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('最近关闭 1');
    expect(toggle.getAttribute('aria-label')).toBe('收起最近关闭的工作区页面');
    expect(restore.textContent).toBe(`恢复 ${FILE_SURFACE.title}`);
    await act(async () => writeShellLanguage('en'));
    expect(restore.textContent).toBe(`Restore ${FILE_SURFACE.title}`);
    await act(async () => restore.click());
    expect(useF307ExperienceWorkbenchStore.getState().layout).toMatchObject({
      surfaces: [FILE_SURFACE],
      activeSurfaceId: FILE_SURFACE.id,
      recentlyClosed: [],
    });
  });

  it.each([
    'v2',
    'classic',
  ] as const)('uses %s activity and restore labels with an English preference', async (presentation) => {
    writeShellPresentation(presentation);
    writeShellLanguage('en');
    const activity = {
      id: 'locale-test',
      kind: 'surface-ready' as const,
      message: '人写的提示',
      surface: FILE_SURFACE,
    };
    useF307ExperienceWorkbenchStore.setState({
      layout: {
        ...createInitialWorkbenchState([BROWSER_SURFACE]),
        recentlyClosed: [FILE_SURFACE],
        activity: [activity],
      },
      hydrated: true,
    });
    await renderWorkbench();
    const notice = container.querySelector('[data-testid="f307-activity-surface-ready"]')!;
    expect(notice.querySelector('p')?.textContent).toBe(activity.message);
    const [open, dismiss] = Array.from(notice.querySelectorAll<HTMLButtonElement>('button'));
    expect(open.textContent?.trim()).toBe(presentation === 'v2' ? 'View' : '查看');
    expect(dismiss.getAttribute('aria-label')).toBe(presentation === 'v2' ? 'Dismiss notification' : '关闭提醒');
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="f307-recently-closed-toggle"]')!;
    expect(toggle.getAttribute('aria-label')).toBe(
      presentation === 'v2' ? 'Expand recently closed Workspace pages' : '展开最近关闭的工作区页面',
    );
    await act(async () => toggle.click());
    const restore = container.querySelector<HTMLButtonElement>('[data-testid="f307-restore-code"]')!;
    expect(restore.textContent).toBe(`${presentation === 'v2' ? 'Restore' : '恢复'} ${FILE_SURFACE.title}`);
    await act(async () => dismiss.click());
    expect(useF307ExperienceWorkbenchStore.getState().layout.activity).toEqual([]);
  });

  it('focuses Home when hydration filters every persisted surface as owner-invalid', async () => {
    const unavailableSurface = {
      ...FILE_SURFACE,
      ownerStateRef: { owner: 'removed-owner', key: 'worktree-a' },
    };
    window.localStorage.setItem(
      WORKBENCH_STORAGE_KEY,
      JSON.stringify({
        ...createInitialWorkbenchState([unavailableSurface]),
        recentlyClosed: [],
      }),
    );
    useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState(), hydrated: false });

    await renderWorkbench();

    expect(useF307ExperienceWorkbenchStore.getState().hydrated).toBe(true);
    expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces).toEqual([]);
    expect(container.querySelector('[data-testid="f307-workspace-home-page"]')).not.toBeNull();
    expect(
      container.querySelector<HTMLElement>('[data-testid="f307-experience-workbench"]')?.dataset.workbenchFocus,
    ).toBe('home');
    expect(
      container.querySelector<HTMLElement>('[data-testid="f307-experience-workbench"]')?.dataset.zeroTopologyContract,
    ).toBe('canonical-home');
  });
});
