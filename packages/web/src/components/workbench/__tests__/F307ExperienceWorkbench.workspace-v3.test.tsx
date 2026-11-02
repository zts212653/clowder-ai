import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { act, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MAILBOX_NAVIGATE_EVENT } from '@/components/shell/mailbox/mailbox-navigation';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import type { OpenHomeArtifact } from '@/components/workspace-home/HomeWorksSummary';
import type { WorkspaceToolsContentProps } from '@/components/workspace-home/WorkspaceToolsContent';
import { useChatStore } from '@/stores/chatStore';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { F307ExperienceWorkbench } from '../F307ExperienceWorkbench';
import type { F307OwnerSurfaceRenderer } from '../F307OwnerSurfaceRenderer';
import type { F307WorkbenchTabsProps } from '../F307WorkbenchTabs';
import {
  artifactObjectId,
  createArtifactSurface,
  createFileSurface,
  createWorkspaceDestinationSurface,
  createWorkspaceModeSurface,
  resolveFileTarget,
  resolvePullRequestChangesTarget,
} from '../real-surface-adapters';
import type { WorkspaceSurfaceDescriptor } from '../workbench-contract';
import { createInitialWorkbenchState } from '../workbench-model';

const probes = vi.hoisted(() => ({
  recent: [] as string[],
  toolsQuery: '',
  openArtifact: vi.fn(),
  homeArtifact: null as ThreadArtifactDTO | null,
  homeOrigin: null as Parameters<OpenHomeArtifact>[1] | null,
  homeSurface: null as WorkspaceSurfaceDescriptor | null,
}));
const artifact: ThreadArtifactDTO = {
  type: 'image',
  name: 'same-message-image',
  url: '/uploads/image.png',
  catId: 'codex61-sol',
  sourceMessageId: 'message-source',
  createdAt: 17,
  publicationItem: { kind: 'content-block', index: 1 },
};
const origin = {
  kind: 'workspace-home-artifact' as const,
  threadId: 'thread-a',
  artifactId: artifactObjectId(artifact),
  viewportOffsetPx: -22,
};

vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => true }));
vi.mock('@/components/listen-mode/ListenModePlayer', () => ({ ListenModePlayer: () => null }));
vi.mock('../F307WorkbenchSidecar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../F307WorkbenchSidecar')>()),
  F307WorkbenchSidecar: () => null,
}));
vi.mock('../F307SurfacePane', () => ({ F307SurfacePane: ({ children }: { children: ReactNode }) => children }));
vi.mock('../F307OwnerSurfaceRenderer', () => ({
  F307OwnerSurfaceRenderer: (props: ComponentProps<typeof F307OwnerSurfaceRenderer>) => (
    <button
      type="button"
      data-testid="owner-back-probe"
      onClick={() => {
        if (props.surface.navigationOrigin) props.onReturnToFileOrigin?.(props.surface, props.surface.navigationOrigin);
      }}
    >
      Back
    </button>
  ),
}));
vi.mock('../F307WorkbenchTabs', () => ({
  F307WorkbenchTabs: ({ toolsContent }: Pick<F307WorkbenchTabsProps, 'toolsContent'>) => (
    <div>{toolsContent?.(() => undefined, { open: true, viewport: { current: null } })}</div>
  ),
}));
vi.mock('@/components/workspace-home/WorkspaceToolsContent', () => ({
  WorkspaceToolsContent: (props: WorkspaceToolsContentProps) => {
    probes.recent = props.recentSurfaces.map((surface) => surface.id);
    probes.toolsQuery = props.initialSearchQuery ?? '';
    return (
      <div data-testid="tools-probe">
        {props.recentSurfaces.map((surface) => (
          <button
            type="button"
            key={surface.id}
            data-recent-id={surface.id}
            onClick={() => props.onSelectRecentSurface(surface)}
          >
            {surface.title}
          </button>
        ))}
      </div>
    );
  },
}));
vi.mock('@/components/workspace-home/WorkspaceHomeV2', () => ({
  WorkspaceHomeV2: ({
    onOpenArtifact,
    returnArtifactId,
  }: {
    onOpenArtifact?: OpenHomeArtifact;
    returnArtifactId?: string;
  }) => (
    <div data-testid="home-probe" data-return-artifact={returnArtifactId}>
      <button
        type="button"
        data-testid="annotate-probe"
        onClick={() => {
          if (probes.homeArtifact && probes.homeOrigin)
            onOpenArtifact?.(
              probes.homeArtifact,
              probes.homeOrigin,
              probes.homeSurface ??
                createArtifactSurface({
                  threadId: probes.homeOrigin.threadId,
                  artifact: probes.homeArtifact,
                  navigationOrigin: probes.homeOrigin,
                }),
            );
        }}
      >
        批注
      </button>
    </div>
  ),
}));

let container: HTMLDivElement;
let root: Root;
let previousChat: ReturnType<typeof useChatStore.getState>;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  writeShellPresentation('v2');
  previousChat = useChatStore.getState();
  useChatStore.setState({
    currentThreadId: 'thread-a',
    presentationLock: null,
    openPublishedArtifact: probes.openArtifact,
  });
  useF307ExperienceWorkbenchStore.setState({
    layout: createInitialWorkbenchState(),
    hydrated: true,
    focusSurfaceId: null,
    mainAreaAttentionSurfaceId: null,
  });
  probes.recent = [];
  probes.toolsQuery = '';
  probes.openArtifact.mockClear();
  probes.homeArtifact = artifact;
  probes.homeOrigin = origin;
  probes.homeSurface = null;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useChatStore.setState(previousChat, true);
  localStorage.clear();
  vi.restoreAllMocks();
});
async function renderHost(foregroundSurfaceId: string | null = null) {
  await act(async () =>
    root.render(
      <F307ExperienceWorkbench
        threadId="thread-a"
        foregroundSurfaceId={foregroundSurfaceId}
        defaultCatId="codex61-sol"
        onSelectDevSurface={() => undefined}
        onOpenAppRoute={() => undefined}
        worktreeId="worktree-a"
        openFilePath={null}
        preview={{ path: '/' }}
      />,
    ),
  );
}

it.each(['now', 'needs-me'] as const)('retires a selected persisted %s tab through its current entry', async (id) => {
  const legacy =
    id === 'now'
      ? createWorkspaceDestinationSurface(
          { kind: 'host', id: 'now', label: '正在发生', description: 'Persisted legacy destination', searchTerms: '' },
          'thread-a',
        )
      : createWorkspaceModeSurface('needs-me', 'thread-a');
  const other = createWorkspaceModeSurface('schedule', 'thread-a');
  if (!legacy) throw new Error('Missing persisted legacy destination');
  useF307ExperienceWorkbenchStore.setState({
    layout: {
      ...createInitialWorkbenchState([legacy, other]),
      activeSurfaceId: legacy.id,
    },
  });
  const mailbox = vi.fn();
  window.addEventListener(MAILBOX_NAVIGATE_EVENT, mailbox);
  try {
    await renderHost(legacy.id);
    expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces.map((s) => s.id)).toEqual([other.id]);
    expect(container.querySelector('[data-testid="home-probe"]')).not.toBeNull();
    expect(mailbox).toHaveBeenCalledTimes(id === 'needs-me' ? 1 : 0);
    expect(probes.recent).not.toContain(legacy.id);
  } finally {
    window.removeEventListener(MAILBOX_NAVIGATE_EVENT, mailbox);
  }
});

it('keeps latent legacy tabs until explicitly selected and does not steal another foreground', async () => {
  const legacy = createWorkspaceModeSurface('needs-me', 'thread-a');
  const other = createWorkspaceModeSurface('schedule', 'thread-a');
  useF307ExperienceWorkbenchStore.setState({
    layout: {
      ...createInitialWorkbenchState([legacy, other]),
      activeSurfaceId: legacy.id,
    },
  });
  await renderHost(other.id);
  expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces.map((s) => s.id)).toContain(legacy.id);
  expect(container.querySelector('[data-testid="home-probe"]')).toBeNull();
});

it('supplies the canonical current-host MRU in visit order, without taking tab order or another thread', async () => {
  const a = createWorkspaceModeSurface('artifacts', 'thread-a');
  const b = createWorkspaceModeSurface('schedule', 'thread-a');
  useF307ExperienceWorkbenchStore.setState({
    layout: {
      ...createInitialWorkbenchState([a, b]),
      recentSurfaceIdsByThread: { 'thread-a': [b.id, a.id], 'thread-b': [a.id] },
    },
  });
  await renderHost();
  expect(container.querySelector('[data-testid="tools-probe"]')).not.toBeNull();
  expect(probes.recent).toEqual([b.id, a.id]);
});

it('restores a recent closed owner through its original action and records only this explicit host visit', async () => {
  const live = createWorkspaceModeSurface('artifacts', 'thread-a');
  const closed = createWorkspaceModeSurface('schedule', 'thread-a');
  useF307ExperienceWorkbenchStore.setState({
    layout: {
      ...createInitialWorkbenchState([live]),
      recentlyClosed: [closed],
      recentSurfaceIdsByThread: { 'thread-a': [closed.id, live.id], 'thread-b': [live.id] },
    },
  });
  await renderHost();
  const button = container.querySelector<HTMLButtonElement>(`[data-recent-id="${closed.id}"]`);
  expect(button).not.toBeNull();
  await act(async () => button?.click());
  const next = useF307ExperienceWorkbenchStore.getState().layout;
  expect(next.activeSurfaceId).toBe(closed.id);
  expect(next.surfaces.map((surface) => surface.id)).toContain(closed.id);
  expect(next.recentSurfaceIdsByThread?.['thread-b']).toEqual([live.id]);
});

it('passes the full publication item and signed Home origin to the existing artifact owner', async () => {
  await renderHost();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="annotate-probe"]')?.click());
  expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces).toContainEqual(
    createArtifactSurface({ threadId: 'thread-a', artifact, navigationOrigin: origin }),
  );
  expect(probes.openArtifact).not.toHaveBeenCalled();
});

it('attaches the already resolved Home file and keeps its original path instead of rebuilding an artifact', async () => {
  const path = '.cat-cafe/uploads/中文讨论稿.md';
  probes.homeSurface = createFileSurface({ worktreeId: 'upload-root', path, navigationOrigin: origin });
  await renderHost();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="annotate-probe"]')?.click());
  const state = useF307ExperienceWorkbenchStore.getState().layout;
  const selected = state.surfaces.find((surface) => surface.id === state.activeSurfaceId);
  expect(selected).toEqual(probes.homeSurface);
  expect(resolveFileTarget(selected!)).toMatchObject({ worktreeId: 'upload-root', path });
  expect(probes.openArtifact).not.toHaveBeenCalled();
});

it('opens a Home PR in exact Changes and returns to its same canonical card through ordinary Back', async () => {
  const pr: ThreadArtifactDTO = { ...artifact, type: 'pr', name: 'PR seven', ref: 'owner/repo#7' };
  const prOrigin = { ...origin, artifactId: artifactObjectId(pr) };
  probes.homeArtifact = pr;
  probes.homeOrigin = prOrigin;
  await renderHost();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="annotate-probe"]')?.click());
  expect(probes.openArtifact).not.toHaveBeenCalled();
  const layout = useF307ExperienceWorkbenchStore.getState().layout;
  const surface = layout.surfaces.find((item) => item.id === layout.activeSurfaceId);
  expect(surface).toBeDefined();
  if (!surface) throw new Error('Missing accepted PR Changes surface');
  expect(resolvePullRequestChangesTarget(surface)).toEqual({
    kind: 'github-pr',
    v: 1,
    repoFullName: 'owner/repo',
    prNumber: 7,
    worktreeId: 'worktree-a',
    threadId: 'thread-a',
  });
  expect(surface.navigationOrigin).toEqual(prOrigin);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="owner-back-probe"]')?.click());
  expect(container.querySelector('[data-testid="home-probe"]')?.getAttribute('data-return-artifact')).toBe(
    prOrigin.artifactId,
  );
});

it.each([
  'workspace-tools-search',
  'workspace-home-search',
] as const)('returns %s from a non-file publication before the file-only guard, into the real tools query', async (kind) => {
  const navigationOrigin =
    kind === 'workspace-tools-search'
      ? { kind, threadId: 'thread-a', query: 'DESIGN.md', viewportOffsetPx: -22 }
      : { kind, query: 'DESIGN.md', viewportOffsetPx: 900 };
  const surface = createArtifactSurface({ threadId: 'source-thread', artifact, navigationOrigin });
  useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([surface]) });
  await renderHost(surface.id);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="owner-back-probe"]')?.click());
  expect(probes.toolsQuery).toBe('DESIGN.md');
  expect(
    container.querySelector('[data-testid="f307-experience-workbench"]')?.getAttribute('data-workbench-focus'),
  ).toBe('surface');
  expect(useF307ExperienceWorkbenchStore.getState().layout.activeSurfaceId).toBe(surface.id);
});

it('refuses a foreign tools origin without borrowing its query or rewriting the active owner', async () => {
  const surface = createArtifactSurface({
    threadId: 'source-thread',
    artifact,
    navigationOrigin: {
      kind: 'workspace-tools-search',
      threadId: 'thread-b',
      query: 'private-query',
      viewportOffsetPx: 84,
    },
  });
  useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([surface]) });
  await renderHost(surface.id);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="owner-back-probe"]')?.click());
  expect(probes.toolsQuery).toBe('');
  expect(useF307ExperienceWorkbenchStore.getState().layout.activeSurfaceId).toBe(surface.id);
  expect(container.querySelector('[data-testid="home-probe"]')).toBeNull();
});

it('restores the original Home card identity from a publication without requiring a file target', async () => {
  const surface = createArtifactSurface({ threadId: 'source-thread', artifact, navigationOrigin: origin });
  useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([surface]) });
  await renderHost(surface.id);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="owner-back-probe"]')?.click());
  expect(container.querySelector('[data-testid="home-probe"]')?.getAttribute('data-return-artifact')).toBe(
    origin.artifactId,
  );
  expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces.map((item) => item.id)).toEqual([surface.id]);
});

function legacyNow() {
  const surface = createWorkspaceDestinationSurface(
    {
      kind: 'host',
      id: 'now',
      label: 'Happening now',
      description: 'Old standalone page',
      searchTerms: '',
    },
    'thread-a',
  );
  if (!surface) throw new Error('Expected persisted legacy destination');
  return surface;
}
it('closes the selected persisted now tab and returns to Home while retaining the other tabs', async () => {
  const old = legacyNow(),
    other = createWorkspaceModeSurface('schedule', 'thread-a');
  const layout = createInitialWorkbenchState([other, old]);
  useF307ExperienceWorkbenchStore.setState({ layout: { ...layout, activeSurfaceId: old.id } });
  await renderHost(old.id);
  expect(container.querySelector('[data-testid="home-probe"]')).not.toBeNull();
  expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces.map((s) => s.id)).toEqual([other.id]);
});
it('retains an inactive old now tab until it is selected and does not offer it in recent tools', async () => {
  const old = legacyNow(),
    other = createWorkspaceModeSurface('schedule', 'thread-a');
  useF307ExperienceWorkbenchStore.setState({
    layout: {
      ...createInitialWorkbenchState([other, old]),
      activeSurfaceId: other.id,
      recentSurfaceIdsByThread: { 'thread-a': [old.id, other.id] },
    },
  });
  await renderHost(other.id);
  expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces.map((s) => s.id)).toContain(old.id);
  expect(probes.recent).toEqual([other.id]);
  await act(async () =>
    useF307ExperienceWorkbenchStore.getState().dispatch({
      type: 'activate-surface',
      surfaceId: old.id,
      entitlement: { kind: 'user', reason: 'surface-tab' },
    }),
  );
  await renderHost(old.id);
  expect(container.querySelector('[data-testid="home-probe"]')).not.toBeNull();
  expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces.map((s) => s.id)).toEqual([other.id]);
});

it('does not retire an old active-layout hint when the host has restored a different foreground', async () => {
  const old = legacyNow(),
    other = createWorkspaceModeSurface('schedule', 'thread-a');
  useF307ExperienceWorkbenchStore.setState({
    layout: {
      ...createInitialWorkbenchState([other, old]),
      activeSurfaceId: old.id,
    },
  });
  await renderHost(other.id);
  expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces.map((surface) => surface.id)).toEqual([
    other.id,
    old.id,
  ]);
});
