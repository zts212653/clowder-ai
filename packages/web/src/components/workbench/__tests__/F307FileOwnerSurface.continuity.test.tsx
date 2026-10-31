import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { F307FileOwnerSurface } from '../F307FileOwnerSurface';
import { createFileSurface, createFilesSurface } from '../real-surface-adapters';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  handlers: new Map<string, (payload?: unknown) => void>(),
  emit: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:3102',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('socket.io-client', () => ({
  io: () => ({
    on: (event: string, handler: (payload?: unknown) => void) => mocks.handlers.set(event, handler),
    emit: mocks.emit,
    disconnect: mocks.disconnect,
  }),
}));
vi.mock('../content-review/WorkspaceContentReviewSurface', () => ({
  WorkspaceContentReviewSurface: ({
    onOpenFileTools,
    fileReader,
  }: {
    onOpenFileTools: () => void;
    fileReader?: () => ReactNode;
  }) => (
    <>
      {fileReader?.()}
      <button type="button" data-testid="open-file-tools" onClick={onOpenFileTools}>
        文件工具
      </button>
    </>
  ),
}));
vi.mock('@/components/workspace/WorkspaceFileViewer', () => ({
  WorkspaceFileViewer: (props: {
    file: { content: string };
    onDirtyChange?: (dirty: boolean) => void;
    pendingExternalSha?: string | null;
    onRevealInTree?: () => void;
    restoreScrollTop?: number | null;
    onScrollTopChange?: (scrollTop: number) => void;
  }) => (
    <div
      data-testid="file-owner-viewer"
      data-content={props.file.content}
      data-pending-external-sha={props.pendingExternalSha ?? ''}
      data-restore-scroll={props.restoreScrollTop ?? ''}
    >
      <button type="button" data-testid="mark-file-dirty" onClick={() => props.onDirtyChange?.(true)}>
        dirty
      </button>
      <button type="button" data-testid="reveal-file-in-tree" onClick={props.onRevealInTree}>
        在文件列表中定位
      </button>
      <button type="button" data-testid="scroll-file-owner" onClick={() => props.onScrollTopChange?.(411)}>
        scroll
      </button>
    </div>
  ),
}));

describe('F307 file owner continuity', () => {
  let container: HTMLDivElement;
  let root: Root;
  let content = 'owner-a';
  let sha256 = 'sha-a';

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.handlers.clear();
    mocks.emit.mockReset();
    mocks.disconnect.mockReset();
    mocks.apiFetch.mockReset().mockImplementation(async (url: string) => {
      if (url.startsWith('/api/workspace/file?')) {
        return new Response(
          JSON.stringify({ path: 'README.md', content, sha256, size: content.length, mime: 'text/markdown' }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected API call: ${url}`);
    });
    useChatStore.setState({ presentationLock: null, workspaceScrollTop: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useChatStore.setState({ presentationLock: null, workspaceScrollTop: null });
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderOwner(worktreeId = 'worktree-a') {
    await act(async () => {
      root.render(
        <F307FileOwnerSurface
          surface={createFileSurface({ worktreeId, path: 'README.md' })}
          onRequestDetach={() => undefined}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.dynamicImportSettled();
    await act(async () => {
      await Promise.resolve();
    });
  }

  const fileReads = () => mocks.apiFetch.mock.calls.filter(([url]) => String(url).startsWith('/api/workspace/file?'));

  it('uses the original file viewport ports for only the exact locked worktree and path', async () => {
    writeShellPresentation('v2');
    useChatStore.setState({
      workspaceWorktreeId: 'worktree-a',
      workspaceOpenFilePath: 'README.md',
      workspaceOpenFileLine: 12,
      workspaceOpenTabs: ['README.md'],
    });
    useChatStore.getState().enablePresentationLock();
    useChatStore.getState().setPresentationLockViewport(320);
    try {
      await renderOwner();
      act(() => container.querySelector<HTMLButtonElement>('[data-testid="open-file-tools"]')!.click());
      const viewer = container.querySelector<HTMLElement>('[data-testid="file-owner-viewer"]');
      expect(viewer?.dataset.restoreScroll).toBe('320');
      act(() => container.querySelector<HTMLButtonElement>('[data-testid="scroll-file-owner"]')?.click());
      expect(useChatStore.getState().presentationLock?.scrollTop).toBe(411);

      await renderOwner('worktree-b');
      act(() => container.querySelector<HTMLButtonElement>('[data-testid="open-file-tools"]')!.click());
      expect(container.querySelector<HTMLElement>('[data-testid="file-owner-viewer"]')?.dataset.restoreScroll).toBe('');
      act(() => container.querySelector<HTMLButtonElement>('[data-testid="scroll-file-owner"]')?.click());
      expect(useChatStore.getState().presentationLock?.scrollTop).toBe(411);
    } finally {
      act(() => writeShellPresentation('classic'));
    }
  });

  it.each([
    'worktree-a',
    `f063_root_v1_${'a'.repeat(64)}`,
  ])('reveals the file resolved as %s through its original tree without replacing either owner', async (resolvedWorktreeId) => {
    const store = useF307ExperienceWorkbenchStore;
    const originalLayout = store.getState().layout;
    const originalTree = createFilesSurface('worktree-a', { repoRoot: '/external/checkout' });
    const aliasFile = createFileSurface({
      worktreeId: 'worktree-a',
      path: 'README.md',
      navigationOrigin: { kind: 'file-tree', worktreeId: 'worktree-a', repoRoot: '/external/checkout' },
    });
    writeShellPresentation('v2');
    try {
      store.getState().dispatch({
        type: 'open-surface',
        surface: originalTree,
        entitlement: { kind: 'user', reason: 'workspace-home-selection' },
      });
      store.getState().dispatch({
        type: 'open-surface',
        surface: aliasFile,
        entitlement: { kind: 'user', reason: 'open-from-chat' },
      });
      if (resolvedWorktreeId !== 'worktree-a') {
        store.getState().dispatch({
          type: 'resolve-content-surface',
          sourceSurfaceId: aliasFile.id,
          surface: createFileSurface({ worktreeId: resolvedWorktreeId, path: 'README.md' }),
        });
      }
      const source = store
        .getState()
        .layout.surfaces.find((surface) => surface.id === `file-owner:${resolvedWorktreeId}`);
      if (!source) throw new Error('canonical file resolution must retain the source navigation coordinate');
      expect(source.navigationOrigin).toEqual(aliasFile.navigationOrigin);
      await act(async () => {
        root.render(<F307FileOwnerSurface surface={source} onRequestDetach={() => undefined} />);
        for (let i = 0; i < 6; i += 1) await Promise.resolve();
      });
      await vi.dynamicImportSettled();
      await act(async () => {
        await Promise.resolve();
      });
      act(() => container.querySelector<HTMLButtonElement>('[data-testid="open-file-tools"]')!.click());
      const viewer = container.querySelector('[data-testid="file-owner-viewer"]');
      expect(viewer).not.toBeNull();
      const reveal = container.querySelector<HTMLButtonElement>('[data-testid="reveal-file-in-tree"]');
      expect(reveal).not.toBeNull();
      if (!viewer || !reveal) throw new Error('the loaded file must expose its directory action');
      act(() => reveal.click());
      const layout = store.getState().layout;
      const active = layout.surfaces.find((surface) => surface.id === layout.activeSurfaceId);
      expect(active?.id).toBe(originalTree.id);
      expect(active?.ownerStateRef).toEqual({ owner: 'f063-workspace-tree', key: 'worktree-a' });
      expect(active?.filesReveal).toMatchObject({ path: 'README.md' });
      expect(active?.filesReveal?.request).toBeGreaterThan(0);
      expect(active?.filesRepoRoot).toBe('/external/checkout');
      expect(layout.surfaces).toContainEqual(source);
      expect(container.querySelector('[data-testid="file-owner-viewer"]')).toBe(viewer);
      const request = active?.filesReveal?.request;
      if (request === undefined) throw new Error('the directory owner must receive a reveal request');
      act(() => reveal.click());
      const repeated = store.getState().layout.surfaces.find((surface) => surface.id === active?.id);
      expect(repeated?.filesReveal?.request).toBe(request + 1);
    } finally {
      act(() => {
        store.setState({ layout: originalLayout });
        writeShellPresentation('classic');
      });
    }
  });

  it('reuses one read, isolates worktrees, and never overwrites a dirty editor on external change', async () => {
    await renderOwner();
    expect(fileReads()).toHaveLength(1);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="open-file-tools"]')?.click());
    const viewer = container.querySelector<HTMLElement>('[data-testid="file-owner-viewer"]');
    expect(viewer?.dataset.content).toBe('owner-a');

    await renderOwner();
    expect(fileReads()).toHaveLength(1);
    expect(container.querySelector('[data-testid="file-owner-viewer"]')).toBe(viewer);

    mocks.handlers.get('connect')?.();
    expect(mocks.emit).toHaveBeenCalledWith('workspace:watch-file', {
      worktreeId: 'worktree-a',
      path: 'README.md',
      sha256: 'sha-a',
    });

    mocks.handlers.get('workspace:file-changed')?.({
      worktreeId: 'worktree-b',
      path: 'README.md',
      sha256: 'sha-b',
    });
    expect(fileReads()).toHaveLength(1);

    content = 'owner-a-updated';
    sha256 = 'sha-b';
    await act(async () => {
      mocks.handlers.get('workspace:file-changed')?.({
        worktreeId: 'worktree-a',
        path: 'README.md',
        sha256: 'sha-b',
      });
      for (let flush = 0; flush < 6; flush += 1) await Promise.resolve();
    });
    expect(fileReads()).toHaveLength(2);
    expect(viewer?.dataset.content).toBe('owner-a-updated');

    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mark-file-dirty"]')?.click());
    content = 'must-not-replace-draft';
    sha256 = 'sha-c';
    await act(async () => {
      mocks.handlers.get('workspace:file-changed')?.({
        worktreeId: 'worktree-a',
        path: 'README.md',
        sha256: 'sha-c',
      });
      await Promise.resolve();
    });
    expect(fileReads()).toHaveLength(2);
    expect(viewer?.dataset.content).toBe('owner-a-updated');
    expect(viewer?.dataset.pendingExternalSha).toBe('sha-c');
  });
});
