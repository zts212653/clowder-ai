import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { F307FileOwnerSurface } from '../F307FileOwnerSurface';
import { createFileSurface } from '../real-surface-adapters';

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
vi.mock('@/components/workspace/WorkspaceFileViewer', () => ({
  WorkspaceFileViewer: (props: {
    file: { content: string };
    onDirtyChange?: (dirty: boolean) => void;
    pendingExternalSha?: string | null;
  }) => (
    <div
      data-testid="file-owner-viewer"
      data-content={props.file.content}
      data-pending-external-sha={props.pendingExternalSha ?? ''}
    >
      <button type="button" data-testid="mark-file-dirty" onClick={() => props.onDirtyChange?.(true)}>
        dirty
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
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

  it('reuses one read, isolates worktrees, and never overwrites a dirty editor on external change', async () => {
    await renderOwner();
    expect(fileReads()).toHaveLength(1);
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
