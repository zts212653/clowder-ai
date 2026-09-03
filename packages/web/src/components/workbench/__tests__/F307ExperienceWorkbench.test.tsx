import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeTeamWorkspaceSubject } from '@/components/routing-context/team-navigation';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { createInitialWorkbenchState } from '@/components/workbench/workbench-model';
import { WORKBENCH_STORAGE_KEY } from '@/components/workbench/workbench-persistence';
import type { WorkspaceOpenRequest } from '@/stores/chat-types';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { F307ExperienceWorkbench } from '../F307ExperienceWorkbench';

const mocks = vi.hoisted(() => ({
  isDesktop: true,
  executionsByKey: {} as Record<string, ActiveExecutionProjection>,
}));

vi.mock('@/hooks/useIsDesktop', () => ({
  useIsDesktop: () => mocks.isDesktop,
}));

vi.mock('@/stores/activeExecutionStore', () => ({
  useActiveExecutionStore: (
    selector: (state: { executionsByKey: Record<string, ActiveExecutionProjection> }) => unknown,
  ) => selector({ executionsByKey: mocks.executionsByKey }),
}));

vi.mock('../F307OwnerSurfaceRenderer', () => ({
  F307OwnerSurfaceRenderer: ({ surface }: { surface: WorkspaceSurfaceDescriptor }) => (
    <div data-testid={`owner-surface-${surface.type}`}>{surface.title}</div>
  ),
}));

vi.mock('../F307SurfacePane', () => ({
  F307SurfacePane: ({ children, visible }: { children: React.ReactNode; visible: boolean }) => (
    <div data-visible={visible}>{children}</div>
  ),
}));

vi.mock('../F307WorkbenchSidecar', () => ({
  F307WorkbenchSidecar: () => <div data-testid="workbench-sidecar" />,
}));

vi.mock('../F307WorkspaceHomePage', () => ({
  F307WorkspaceHomePage: () => <div data-testid="f307-workspace-home-page">Canonical Workspace Home</div>,
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
    mocks.executionsByKey = {};
    window.localStorage.clear();
    useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState(), hydrated: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.clear();
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState(),
      hydrated: false,
      hydrate: hydrateWorkbench,
    });
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
  });

  async function renderWorkbench(workspaceOpenRequest?: WorkspaceOpenRequest, onConsumed?: (revision: number) => void) {
    await act(async () => {
      root.render(
        <F307ExperienceWorkbench
          threadId="thread-a"
          onSelectDevSurface={() => undefined}
          worktreeId="worktree-a"
          openFilePath={null}
          preview={{ path: '/' }}
          workspaceOpenRequest={workspaceOpenRequest}
          onWorkspaceOpenRequestConsumed={onConsumed}
        />,
      );
    });
  }

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

  it('keeps the add-tab affordance inline after the active tab and focuses Home without changing topology', async () => {
    useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([FILE_SURFACE]), hydrated: true });
    await renderWorkbench();

    const workbench = container.querySelector<HTMLElement>('[data-testid="f307-experience-workbench"]');
    const strip = container.querySelector<HTMLElement>('[data-testid="f307-tab-strip"]');
    const addSurface = container.querySelector<HTMLButtonElement>('[data-testid="f307-add-surface"]');
    expect(strip?.lastElementChild).toBe(addSurface);
    expect(workbench?.dataset.workbenchFocus).toBe('surface');
    expect(workbench?.dataset.surfaceCount).toBe('1');

    await act(async () => addSurface?.click());

    expect(container.querySelector('[data-testid="f307-workspace-home-page"]')).not.toBeNull();
    expect(workbench?.dataset.workbenchFocus).toBe('home');
    expect(useF307ExperienceWorkbenchStore.getState().layout).toMatchObject({
      surfaces: [FILE_SURFACE],
      activeSurfaceId: FILE_SURFACE.id,
      split: null,
    });
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
