import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { createFilePreviewSurface, resolveFileTarget } from '@/components/workbench/real-surface-adapters';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { createInitialWorkbenchState } from '@/components/workbench/workbench-model';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { MarkdownContent } from '../MarkdownContent';
import { WorkspacePanel } from '../WorkspacePanel';

vi.hoisted(() => vi.stubEnv('NEXT_PUBLIC_PROJECT_ROOT', '/tmp/listed'));
afterAll(() => vi.unstubAllEnvs());

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'http://localhost:3102' }));
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
  vi.mocked(apiFetch).mockImplementation(async (url, options) => {
    if (url === '/api/workspace/chat-references') {
      const { groups } = JSON.parse(String(options?.body)) as {
        groups: { threadId: string; references: string[] }[];
      };
      return Response.json({
        groups: groups.map((group) => ({
          threadId: group.threadId,
          results: group.references.map((reference) => {
            const file = /^(docs\/(?:B|C)\.md)(?::(7|40))?$/.exec(reference);
            return {
              reference,
              target: file
                ? {
                    kind: 'file',
                    entryType: 'file',
                    worktreeId: 'listed-worktree',
                    path: file[1],
                    absolutePath: `/tmp/listed/${file[1]}`,
                    line: file[2] ? Number(file[2]) : null,
                    mime: 'text/markdown',
                    size: 42,
                    modifiedAt: '2026-10-23T08:00:00Z',
                  }
                : null,
            };
          }),
        })),
      });
    }
    return {
      ok: true,
      json: async () => ({
        worktrees: [
          { id: 'listed-worktree', canonicalId: 'listed-worktree', root: '/tmp/listed', branch: 'main', head: 'a' },
        ],
        files: [],
        executions: [],
        items: [],
      }),
    } as Response;
  });
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
it('uses the v2 stamp as a preview writer and keeps pinned A when opening B', async () => {
  await act(async () => root.render(<WorkspacePanel threadId="file-stamp-thread" projectPath="/tmp/listed" />));
  const first = await open('docs/A.md', 1);
  expect(first.previewSurfaceId).toBe(first.activeSurfaceId);
  const a = first.surfaces.find((surface) => resolveFileTarget(surface)?.path === 'docs/A.md');
  expect(a).toBeDefined();
  if (!a) throw new Error('Document A did not open');
  await act(async () =>
    useF307ExperienceWorkbenchStore.getState().dispatch({
      type: 'pin-surface',
      surfaceId: a.id,
      pinned: true,
      entitlement: { kind: 'user', reason: 'surface-tab' },
    }),
  );
  const next = await open('docs/B.md', 2);
  const files = next.surfaces.filter((surface) => resolveFileTarget(surface));
  expect(files.map((surface) => resolveFileTarget(surface)?.path)).toEqual(['docs/A.md', 'docs/B.md']);
  expect(next.previewSurfaceId).toBe(files[1]?.id);
  expect(useChatStore.getState().workspaceForegroundSurfaceId).toBe(files[1]?.id);
});
it('keeps classic stamp replacement on the original root owner without a preview slot', async () => {
  writeShellPresentation('classic');
  await act(async () => root.render(<WorkspacePanel threadId="file-stamp-thread" projectPath="/tmp/listed" />));
  await open('docs/A.md', 1);
  const next = await open('docs/B.md', 2);
  expect(next.surfaces.filter((surface) => resolveFileTarget(surface))).toHaveLength(1);
  expect(next.previewSurfaceId).toBeNull();
  expect(next.activeSurfaceId).toBe('file-owner:listed-worktree');
});

it.each([
  'classic',
  'v2',
] as const)('%s chat document links retain A, add B, and reuse B for another line', async (presentation) => {
  writeShellPresentation(presentation);
  let now = 100;
  vi.spyOn(Date, 'now').mockImplementation(() => ++now);
  await act(async () =>
    root.render(
      <>
        <div data-message-id="document-source">
          <MarkdownContent
            referenceThreadId="file-stamp-thread"
            content="[Document B](docs/B.md:7) [B line 40](docs/B.md:40) docs/C.md"
          />
        </div>
        <WorkspacePanel threadId="file-stamp-thread" projectPath="/tmp/listed" />
      </>,
    ),
  );
  const before = await open('docs/A.md', 1);
  const originalA = before.surfaces.find((surface) => resolveFileTarget(surface)?.path === 'docs/A.md');
  expect(originalA).toBeDefined();
  const click = async (label: string) => {
    const link = Array.from(container.querySelectorAll('button, a')).find(
      (item) => item.getAttribute('aria-label') === label,
    );
    expect(link).toBeDefined();
    if (!link) throw new Error(`Missing link: ${label}`);
    await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    return useF307ExperienceWorkbenchStore.getState().layout;
  };
  // The controlled metadata reply follows the batch reader's 8ms flush.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(container.querySelectorAll('[data-chat-reference-kind=file]')).toHaveLength(3);
  const opened = await click('/tmp/listed/docs/B.md:7');
  expect(opened.surfaces.map((surface) => resolveFileTarget(surface)?.path)).toEqual(['docs/A.md', 'docs/B.md']);
  expect(opened.surfaces[0]).toEqual(originalA);
  const b = opened.surfaces[1];
  if (!b) throw new Error('Document B did not open');
  expect(opened.previewSurfaceId).not.toBe(b.id);
  const navigated = await click('/tmp/listed/docs/B.md:40');
  expect(navigated.surfaces).toHaveLength(2);
  expect(navigated.activeSurfaceId).toBe(b.id);
  expect(resolveFileTarget(b)).toMatchObject({ path: 'docs/B.md', scrollToLine: 7 });
  const updatedB = navigated.surfaces[1];
  if (!updatedB) throw new Error('Document B was lost');
  expect(resolveFileTarget(updatedB)).toMatchObject({ path: 'docs/B.md', scrollToLine: 40 });
  // A plain chat path is a verified filename chip; preserve the original tab assertions below.
  const c = await click('/tmp/listed/docs/C.md');
  expect(c.surfaces.map((surface) => resolveFileTarget(surface)?.path)).toEqual([
    'docs/A.md',
    'docs/B.md',
    'docs/C.md',
  ]);
  expect(c.previewSurfaceId).not.toBe(c.activeSurfaceId);
});

it('a chat link promotes the exact preview so the next tree preview retains it', async () => {
  await act(async () =>
    root.render(
      <>
        <MarkdownContent content="[Document A](docs/A.md)" />
        <WorkspacePanel threadId="file-stamp-thread" projectPath="/tmp/listed" />
      </>,
    ),
  );
  const before = await open('docs/A.md', 1);
  const link = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === 'Document A');
  if (!link) throw new Error('Missing document A link');
  await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  const promoted = useF307ExperienceWorkbenchStore.getState().layout;
  expect(promoted.surfaces).toHaveLength(1);
  expect(promoted.activeSurfaceId).toBe(before.activeSurfaceId);
  expect(promoted.previewSurfaceId).toBeNull();
  const after = await open('docs/B.md', 2);
  expect(after.surfaces.map((surface) => resolveFileTarget(surface)?.path)).toEqual(['docs/A.md', 'docs/B.md']);
});

it.each(['classic', 'v2'] as const)('%s consumes a chat document click before the Panel first mounts', async (mode) => {
  writeShellPresentation(mode);
  await act(async () => root.render(<MarkdownContent content="[Document A](docs/A.md)" />));
  const link = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === 'Document A');
  if (!link) throw new Error('Missing document A link');
  await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  await act(async () => root.render(<WorkspacePanel threadId="file-stamp-thread" projectPath="/tmp/listed" />));
  const state = useF307ExperienceWorkbenchStore.getState().layout;
  expect(state.surfaces.map((surface) => resolveFileTarget(surface)?.path)).toEqual(['docs/A.md']);
  expect(state.previewSurfaceId).toBeNull();
});

it('waits for initial worktree discovery without losing the clicked file', async () => {
  useChatStore.setState({ workspaceWorktreeId: null });
  useF307ExperienceWorkbenchStore.setState({ hydrated: false });
  await act(async () => root.render(<MarkdownContent content="[Document A](docs/A.md)" />));
  const link = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === 'Document A');
  if (!link) throw new Error('Missing document A link');
  await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  await act(async () => root.render(<WorkspacePanel threadId="file-stamp-thread" projectPath="/tmp/listed" />));
  const files = useF307ExperienceWorkbenchStore.getState().layout.surfaces;
  expect(files.map((surface) => resolveFileTarget(surface))).toEqual([
    expect.objectContaining({ worktreeId: 'listed-worktree', path: 'docs/A.md' }),
  ]);
  expect(useChatStore.getState().workspaceOpenFilePath).toBe('docs/A.md');
});

it('does not replay a consumed link after its tab closes and the Panel remounts', async () => {
  await act(async () =>
    useChatStore.getState().setWorkspaceOpenFile('docs/A.md', null, null, null, undefined, 'permanent'),
  );
  await act(async () => root.render(<WorkspacePanel threadId="file-stamp-thread" projectPath="/tmp/listed" />));
  const opened = useF307ExperienceWorkbenchStore.getState().layout.activeSurfaceId;
  expect(opened).not.toBeNull();
  if (!opened) throw new Error('Document A did not open');
  await act(async () =>
    useF307ExperienceWorkbenchStore.getState().dispatch({
      type: 'close-surface',
      surfaceId: opened,
      entitlement: { kind: 'user', reason: 'surface-tab' },
    }),
  );
  await act(async () => root.render(null));
  await act(async () => root.render(<WorkspacePanel threadId="file-stamp-thread" projectPath="/tmp/listed" />));
  expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces).toEqual([]);
});

it('a newer explicit Workspace navigation supersedes a cold pending file link', async () => {
  await act(async () =>
    useChatStore.getState().setWorkspaceOpenFile('docs/A.md', null, null, null, undefined, 'permanent'),
  );
  await act(async () =>
    useChatStore.getState().openWorkspacePath('file-stamp-thread', {
      kind: 'file',
      worktreeId: 'listed-worktree',
      path: 'docs/B.md',
    }),
  );
  await act(async () => root.render(<WorkspacePanel threadId="file-stamp-thread" projectPath="/tmp/listed" />));
  expect(
    useF307ExperienceWorkbenchStore.getState().layout.surfaces.map((surface) => resolveFileTarget(surface)?.path),
  ).toEqual(['docs/B.md']);
});

it('hydrates the saved A tab before admitting a cold Chat link to B', async () => {
  await act(async () => root.render(<WorkspacePanel threadId="file-stamp-thread" projectPath="/tmp/listed" />));
  const before = await open('docs/A.md', 1);
  const a = before.surfaces[0];
  await act(async () => root.render(null));
  useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState(), hydrated: false });
  await act(async () =>
    useChatStore.getState().setWorkspaceOpenFile('docs/B.md', 7, null, null, undefined, 'permanent'),
  );
  await act(async () => root.render(<WorkspacePanel threadId="file-stamp-thread" projectPath="/tmp/listed" />));
  const after = useF307ExperienceWorkbenchStore.getState().layout;
  expect(after.surfaces.map((surface) => resolveFileTarget(surface)?.path)).toEqual(['docs/A.md', 'docs/B.md']);
  expect(after.surfaces[0]).toEqual(a);
});

it('opens B after the file owner resolves A to a canonical root outside the listed alias', async () => {
  await act(async () =>
    root.render(
      <>
        <MarkdownContent content="[Document B](docs/B.md:7)" />
        <WorkspacePanel threadId="file-stamp-thread" projectPath="/tmp/listed" />
      </>,
    ),
  );
  const a = await open('docs/A.md', 1);
  const sourceSurfaceId = a.activeSurfaceId;
  if (!sourceSurfaceId) throw new Error('Document A did not open');
  const rootId = `f063_root_v1_${'a'.repeat(64)}`;
  await act(async () =>
    useF307ExperienceWorkbenchStore.getState().dispatch({
      type: 'resolve-content-surface',
      sourceSurfaceId,
      surface: createFilePreviewSurface({ worktreeId: rootId, path: 'docs/A.md', scrollToLine: 1 }),
    }),
  );
  expect(useChatStore.getState().workspaceWorktreeId).toBe(rootId);
  const originalA = useF307ExperienceWorkbenchStore.getState().layout.surfaces[0];
  const link = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === 'Document B');
  if (!link) throw new Error('Missing Document B link');
  await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  const after = useF307ExperienceWorkbenchStore.getState().layout;
  expect(after.surfaces.map((surface) => resolveFileTarget(surface)?.path)).toEqual(['docs/A.md', 'docs/B.md']);
  expect(after.surfaces[0]).toEqual(originalA);
  expect(after.previewSurfaceId).not.toBe(after.activeSurfaceId);
});
