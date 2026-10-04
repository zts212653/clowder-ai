import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { F307FileOwnerSurface } from '../F307FileOwnerSurface';
import { createFileSurface } from '../real-surface-adapters';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:3102',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), emit: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('@/hooks/useFileEditing', () => ({
  useFileEditing: () => ({
    editMode: false,
    setEditMode: vi.fn(),
    saveError: null,
    canEdit: false,
    handleToggleEdit: vi.fn(),
    handleSave: vi.fn(),
  }),
}));
vi.mock('@/components/workspace/WorkspaceFileViewer', () => ({
  WorkspaceFileViewer: ({
    collaborationAvailable,
    onOpenCollaboration,
  }: {
    collaborationAvailable?: boolean;
    onOpenCollaboration?: () => void;
  }) => (
    <div data-testid="workspace-file-viewer">
      {collaborationAvailable ? (
        <button type="button" onClick={onOpenCollaboration}>
          协作批注
        </button>
      ) : null}
    </div>
  ),
}));
vi.mock('../content-review/WorkspaceContentReviewSurface', () => ({
  WorkspaceContentReviewSurface: ({
    worktreeId,
    path,
    sourceText,
    sourceTextRevision,
    navigationOrigin,
    onBack,
    onOpenFileTools,
  }: {
    worktreeId: string;
    path: string;
    sourceText: string;
    sourceTextRevision: string;
    navigationOrigin?: { kind: string; threadId?: string; query?: string };
    onBack: () => void;
    onOpenFileTools: () => void;
  }) => (
    <div
      data-testid="workspace-content-review"
      data-worktree={worktreeId}
      data-path={path}
      data-source={sourceText}
      data-revision={sourceTextRevision}
      data-origin={navigationOrigin?.kind ?? ''}
      data-origin-thread={navigationOrigin?.threadId ?? ''}
    >
      <button type="button" onClick={onBack}>
        返回文件
      </button>
      <button type="button" onClick={onOpenFileTools}>
        文件工具
      </button>
    </div>
  ),
}));

describe('F307 File owner collaboration entry', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.apiFetch.mockReset().mockImplementation(async (url: string) => {
      const path = new URL(`http://local${url}`).searchParams.get('path') ?? '';
      const truncated = path === 'large.md';
      return new Response(
        JSON.stringify({
          path,
          content: truncated ? '# A preview that is deliberately truncated' : '# Note\n\nThe source body.',
          sha256: 'source-sha',
          size: truncated ? 1_200_000 : 25,
          mime: path.endsWith('.png') ? 'image/png' : 'text/markdown',
          binary: path.endsWith('.png'),
          truncated,
        }),
      );
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(path: string) {
    await act(async () => {
      root.render(
        <F307FileOwnerSurface
          surface={createFileSurface({ worktreeId: 'worktree-a', path })}
          onRequestDetach={vi.fn()}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it.each([
    'notes.md',
    'cover.png',
  ])('opens %s directly in the full collaboration surface and can return to file tools', async (path) => {
    await render(path);
    expect(container.querySelector('[data-testid="workspace-file-viewer"]')).toBeNull();
    const review = container.querySelector<HTMLElement>('[data-testid="workspace-content-review"]');
    expect(review?.dataset.worktree).toBe('worktree-a');
    expect(review?.dataset.path).toBe(path);
    expect(review?.dataset.source).toBe('# Note\n\nThe source body.');
    expect(review?.dataset.revision).toBe('sha256:source-sha');
    await act(async () =>
      [...(review?.querySelectorAll('button') ?? [])].find((button) => button.textContent === '文件工具')?.click(),
    );
    expect(container.querySelector('[data-testid="workspace-file-viewer"]')).not.toBeNull();
  });

  it('resets collaboration when one F307 File surface switches from A to B in the same worktree', async () => {
    await render('notes.md');
    expect(container.querySelector<HTMLElement>('[data-testid="workspace-content-review"]')?.dataset.path).toBe(
      'notes.md',
    );

    await act(async () => {
      root.render(
        <F307FileOwnerSurface
          surface={createFileSurface({ worktreeId: 'worktree-a', path: 'other.md' })}
          onRequestDetach={vi.fn()}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector<HTMLElement>('[data-testid="workspace-content-review"]')?.dataset.path).toBe(
      'other.md',
    );
    expect(container.querySelector('[data-testid="workspace-file-viewer"]')).toBeNull();
  });

  it('retains the ordinary chat origin while F309 is open, without turning it into a Task return edge', async () => {
    await act(async () => {
      root.render(
        <F307FileOwnerSurface
          surface={createFileSurface({
            worktreeId: 'worktree-a',
            path: 'notes.md',
            navigationOrigin: { kind: 'chat-file-link', threadId: 'thread-origin', messageId: 'message-origin' },
          })}
          onRequestDetach={vi.fn()}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const review = container.querySelector<HTMLElement>('[data-testid="workspace-content-review"]');
    expect(review?.dataset.origin).toBe('chat-file-link');
    expect(review?.dataset.originThread).toBe('thread-origin');
  });

  it.each([
    { kind: 'file-tree' as const },
    { kind: 'workspace-home-search' as const, query: 'owner contracts' },
    { kind: 'chat-file-link' as const, threadId: 'thread-origin', messageId: 'message-origin' },
  ])('returns a collaboration close through its typed %s origin consumer', async (navigationOrigin) => {
    const onReturnToNavigationOrigin = vi.fn();
    await act(async () => {
      root.render(
        <F307FileOwnerSurface
          surface={createFileSurface({ worktreeId: 'worktree-a', path: 'notes.md', navigationOrigin })}
          onRequestDetach={vi.fn()}
          onReturnToNavigationOrigin={onReturnToNavigationOrigin}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () =>
      container
        .querySelector('[data-testid="workspace-content-review"] button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(onReturnToNavigationOrigin).toHaveBeenCalledWith(navigationOrigin);
  });

  it('does not advertise collaboration for a text preview whose F063 revision is unavailable', async () => {
    await render('large.md');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === '协作批注')).toBe(false);
  });
  it('a missing file keeps the common title, retry and original return instead of stranding the entry', async () => {
    mocks.apiFetch.mockImplementation(async () => new Response('{}', { status: 404 }));
    const origin = { kind: 'workspace-home-search' as const, query: 'notes' };
    const onReturn = vi.fn();
    await act(async () =>
      root.render(
        <F307FileOwnerSurface
          surface={createFileSurface({ worktreeId: 'worktree-a', path: 'notes.md', navigationOrigin: origin })}
          onRequestDetach={vi.fn()}
          onReturnToNavigationOrigin={onReturn}
        />,
      ),
    );
    expect(container.querySelector('h2')?.textContent).toBe('notes.md');
    const back = [...container.querySelectorAll('button')].find((button) => button.textContent === '返回来源');
    expect(back).toBeTruthy();
    await act(async () => back!.click());
    expect(onReturn).toHaveBeenCalledWith(origin);
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === '重新读取')).toBe(true);
  });
  it('a legacy file with no origin returns through its original worktree instead of switching to file tools', async () => {
    const onReturn = vi.fn();
    await act(async () =>
      root.render(
        <F307FileOwnerSurface
          surface={createFileSurface({ worktreeId: 'worktree-a', path: 'notes.md' })}
          onRequestDetach={vi.fn()}
          onReturnToNavigationOrigin={onReturn}
        />,
      ),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="workspace-content-review"] button')!.click(),
    );
    expect(onReturn).toHaveBeenCalledWith({ kind: 'file-tree' });
    expect(container.querySelector('[data-testid="workspace-file-viewer"]')).toBeNull();
  });
  it.each([
    'plugin_not_installed',
    'plugin_disabled',
    'plugin_stopped',
  ])('DOCX retains its source return and common landing when its provider is %s', async (code) => {
    mocks.apiFetch.mockImplementation(async () => new Response(JSON.stringify({ error: { code } }), { status: 409 }));
    const origin = { kind: 'workspace-home-search' as const, query: '说明书' };
    const onReturn = vi.fn();
    await act(async () =>
      root.render(
        <F307FileOwnerSurface
          surface={createFileSurface({ worktreeId: 'worktree-a', path: 'docs/说明书.docx', navigationOrigin: origin })}
          onRequestDetach={vi.fn()}
          onReturnToNavigationOrigin={onReturn}
        />,
      ),
    );
    expect(container.querySelector('h2')?.textContent).toBe('说明书.docx');
    const back = [...container.querySelectorAll('button')].find((button) => button.textContent === '返回来源');
    expect(back).toBeTruthy();
    await act(async () => back!.click());
    expect(onReturn).toHaveBeenCalledWith(origin);
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/settings?s=plugins');
    expect(mocks.apiFetch.mock.calls.every(([url]) => url === '/api/workspace/content-editor')).toBe(true);
  });
});
