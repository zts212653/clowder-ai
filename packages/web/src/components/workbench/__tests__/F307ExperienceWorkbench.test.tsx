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
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { createInitialWorkbenchState } from '@/components/workbench/workbench-model';
import { WORKBENCH_STORAGE_KEY } from '@/components/workbench/workbench-persistence';
import type { WorkspaceOpenRequest } from '@/stores/chat-types';
import { createArtifactReviewSurface } from '../artifact-review-surface';
import { createArtifactWorkPresentationState } from '../artifact-work-presentation';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { F307ExperienceWorkbench } from '../F307ExperienceWorkbench';
import {
  createBrowserSurface,
  createEvolutionProgramSurface,
  createTerminalSurface,
  resolveFilesTarget,
  resolveFileTarget,
} from '../real-surface-adapters';

const mocks = vi.hoisted(() => ({
  openAppRoute: vi.fn(),
  isDesktop: true,
  useNativeViewport: false,
  workbenchVisible: true,
  executionsByKey: {} as Record<string, ActiveExecutionProjection>,
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

vi.mock('@/stores/activeExecutionStore', () => ({
  useActiveExecutionStore: (
    selector: (state: { executionsByKey: Record<string, ActiveExecutionProjection> }) => unknown,
  ) => selector({ executionsByKey: mocks.executionsByKey }),
}));

vi.mock('../F307OwnerSurfaceRenderer', () => ({
  F307OwnerSurfaceRenderer: ({
    surface,
    surfaceVisible,
    focusMode,
    onReturnToFileOrigin,
  }: {
    surface: WorkspaceSurfaceDescriptor;
    surfaceVisible?: boolean;
    focusMode?: boolean;
    onReturnToFileOrigin?: (
      surface: WorkspaceSurfaceDescriptor,
      origin: NonNullable<WorkspaceSurfaceDescriptor['navigationOrigin']>,
    ) => void;
  }) => {
    const origin = surface.navigationOrigin;
    return (
      <div
        data-testid={`owner-surface-${surface.type}`}
        data-owner-surface-id={surface.id}
        data-surface-visible={String(surfaceVisible)}
        data-focus-mode={String(focusMode)}
      >
        {surface.title}
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

vi.mock('../F307WorkbenchSidecar', () => ({
  F307WorkbenchSidecar: ({ visible = true }: { visible?: boolean }) => (
    <div data-testid="workbench-sidecar" data-visible={visible} />
  ),
}));

vi.mock('../F307WorkspaceHomePage', () => ({
  F307WorkspaceHomePage: ({ workspaceSearchQuery }: { workspaceSearchQuery?: string }) => (
    <div data-testid="f307-workspace-home-page" data-workspace-search-query={workspaceSearchQuery ?? ''}>
      Canonical Workspace Home
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
    container.remove();
    vi.unstubAllGlobals();
    window.localStorage.clear();
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

  it('returns a Home-search collaboration close to the original query', async () => {
    const onRestoreWorkspaceSearch = vi.fn();
    const surface = {
      ...FILE_SURFACE,
      navigationOrigin: { kind: 'workspace-home-search' as const, query: 'canonical owner' },
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
    expect(onConsumed).toHaveBeenCalledWith(1);
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
