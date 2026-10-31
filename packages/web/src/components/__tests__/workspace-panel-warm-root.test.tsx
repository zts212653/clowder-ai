import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import {
  createFilePreviewSurface,
  createTerminalSurface,
  resolveChangesTarget,
  resolveFilesTarget,
  resolveFileTarget,
  resolveTerminalWorktreeId,
} from '@/components/workbench/real-surface-adapters';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { createInitialWorkbenchState } from '@/components/workbench/workbench-model';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { WorkspacePanel } from '../WorkspacePanel';

vi.hoisted(() => vi.stubEnv('NEXT_PUBLIC_PROJECT_ROOT', '/tmp/listed'));
afterAll(() => vi.unstubAllEnvs());

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
// Keep the real stamp consumer, foreground binding, dispatch and persisted topology; only the leaf does no file I/O.
vi.mock('@/components/workbench/F307OwnerSurfaceRenderer', () => ({
  F307OwnerSurfaceRenderer: ({ surface }: { surface: WorkspaceSurfaceDescriptor }) => (
    <output data-file-owner={surface.ownerStateRef.key}>{surface.title}</output>
  ),
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  writeShellPresentation('v2');
  useF307ExperienceWorkbenchStore.setState({
    layout: createInitialWorkbenchState(),
    hydrated: true,
    focusSurfaceId: null,
    mainAreaAttentionSurfaceId: null,
  });
  useChatStore.setState({
    currentThreadId: 'file-stamp-thread',
    currentProjectPath: '/tmp/listed',
    workspaceSurface: 'home',
    workspaceWorktreeId: 'listed-worktree',
    workspaceForegroundSurfaceId: null,
    workspaceOpenFilePath: null,
    workspaceOpenFileLine: null,
    workspaceOpenTabs: [],
    workspaceOpenRequest: null,
    workspaceWorktreeAliases: {},
    workspaceWorktreeAliasesProjectPath: null,
    presentationLock: null,
    threadStates: {},
    _workspaceFileSetAt: { ts: 0, threadId: null },
  });
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      worktrees: [
        { id: 'listed-worktree', canonicalId: 'listed-worktree', root: '/tmp/listed', branch: 'main', head: 'a' },
      ],
      files: [],
      executions: [],
      items: [],
    }),
  } as Response);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  writeShellPresentation('classic');
  localStorage.clear();
  vi.mocked(apiFetch).mockReset();
  vi.restoreAllMocks();
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
async function open(path: string, ts: number) {
  await act(async () =>
    useChatStore.setState({
      workspaceOpenFilePath: path,
      workspaceOpenFileLine: ts,
      _workspaceFileSetAt: { ts, threadId: 'file-stamp-thread' },
    }),
  );
  return useF307ExperienceWorkbenchStore.getState().layout;
}

const discoveryProfiles = [
  { projectPath: '/tmp/listed', canonicalId: 'listed-worktree' },
  { projectPath: 'default', canonicalId: null },
];
const warmEntries = (['files', 'changes', 'terminal'] as const).flatMap((destination) =>
  discoveryProfiles.map((profile) => ({ destination, ...profile })),
);
it.each(warmEntries)('reopens $destination on $projectPath after Works returns Home', async ({
  destination,
  projectPath,
  canonicalId,
}) => {
  const rootId = `f063_root_v1_${'a'.repeat(64)}`;
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      worktrees: [
        {
          id: 'listed-worktree',
          canonicalId,
          rootIdentity: rootId,
          root: '/tmp/listed',
          resolvedRoot: '/tmp/listed',
          rootEpoch: 0,
          branch: 'main',
          head: 'a',
        },
      ],
      files: [],
      executions: [],
      items: [],
    }),
  } as Response);
  await act(async () => root.render(<WorkspacePanel threadId="file-stamp-thread" projectPath={projectPath} />));
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.some(
        ([url]) =>
          url ===
          (projectPath === 'default'
            ? '/api/workspace/worktrees'
            : '/api/workspace/worktrees?repoRoot=%2Ftmp%2Flisted'),
      ),
  ).toBe(true);
  const existingPane = createTerminalSurface({ worktreeId: 'listed-worktree' });
  await act(async () =>
    useF307ExperienceWorkbenchStore.getState().dispatch({
      type: 'open-surface',
      surface: existingPane,
      entitlement: { kind: 'user', reason: 'workspace-home-selection' },
    }),
  );
  const before = await open('docs/A.md', 1);
  if (!before.activeSurfaceId) throw new Error('Original reader did not open');
  const sourceSurfaceId = before.activeSurfaceId;
  await act(async () =>
    useF307ExperienceWorkbenchStore.getState().dispatch({
      type: 'resolve-content-surface',
      sourceSurfaceId,
      surface: createFilePreviewSurface({
        worktreeId: rootId,
        path: 'docs/A.md',
        navigationOrigin: { kind: 'workspace-home-search', query: 'original Works' },
      }),
    }),
  );
  expect(useChatStore.getState().workspaceWorktreeId).toBe(rootId);
  const resolved = useF307ExperienceWorkbenchStore.getState().layout;
  const activeReader = resolved.surfaces.find((surface) => surface.id === resolved.activeSurfaceId);
  if (!activeReader) throw new Error('Resolved reader is not active');
  expect(resolveFileTarget(activeReader)).toMatchObject({ worktreeId: rootId, path: 'docs/A.md' });
  expect(activeReader.id).not.toBe(existingPane.id);
  const reader = structuredClone(activeReader);
  const home = container.querySelector<HTMLButtonElement>('[data-testid="v2-workspace-home"]');
  if (!home) throw new Error('Missing Home return');
  await act(async () => home.click());
  const trigger = container.querySelector<HTMLElement>('[data-testid="v2-workspace-tools"]');
  const details = trigger?.closest('details');
  if (!trigger || !details) throw new Error('Missing original + menu');
  vi.spyOn(trigger, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 32, 32)] as unknown as DOMRectList);
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  const button = document.querySelector<HTMLButtonElement>(`[data-workspace-destination="surface:${destination}"]`);
  if (!button) throw new Error(`Missing original ${destination} entry`);
  await act(async () => button.click());
  const after = useF307ExperienceWorkbenchStore.getState().layout;
  const selected = after.surfaces.find((surface) => surface.id === after.activeSurfaceId);
  expect(selected).toBeDefined();
  expect(
    destination === 'files'
      ? selected && resolveFilesTarget(selected)?.worktreeId
      : destination === 'changes'
        ? selected && resolveChangesTarget(selected)?.worktreeId
        : selected && resolveTerminalWorktreeId(selected),
  ).toBe(destination === 'terminal' ? 'listed-worktree' : rootId);
  const panes = after.surfaces.filter((surface) => resolveTerminalWorktreeId(surface));
  expect(panes).toHaveLength(1);
  expect(panes[0]?.id).toBe(existingPane.id);
  expect(panes[0]?.objectRef).toEqual(existingPane.objectRef);
  expect(panes[0]?.ownerStateRef).toEqual(existingPane.ownerStateRef);
  if (destination === 'terminal') expect(selected?.id).toBe(existingPane.id);
  expect(after.surfaces.find((surface) => surface.id === reader.id)).toEqual(reader);
});
