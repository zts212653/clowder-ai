import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { F307FileOwnerSurface } from '../F307FileOwnerSurface';
import { createFileSurface } from '../real-surface-adapters';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), canEdit: false }));

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
    canEdit: mocks.canEdit,
    handleToggleEdit: vi.fn(),
    handleSave: vi.fn(),
  }),
}));
vi.mock('@/components/workspace/WorkspaceFileViewer', () => ({
  WorkspaceFileViewer: ({
    collaborationAvailable,
    onOpenCollaboration,
    collaborationLabel,
    onBack,
  }: {
    collaborationAvailable?: boolean;
    collaborationLabel?: string;
    onBack?: () => void;
    onOpenCollaboration?: () => void;
  }) => (
    <div data-testid="workspace-file-viewer">
      {onBack && (
        <button type="button" onClick={onBack}>
          返回原来源
        </button>
      )}
      {collaborationAvailable ? (
        <button type="button" onClick={onOpenCollaboration}>
          {collaborationLabel ?? '协作批注'}
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
    onApplied,
    fileReader,
  }: {
    worktreeId: string;
    path: string;
    sourceText: string;
    sourceTextRevision: string;
    navigationOrigin?: { kind: string; threadId?: string; query?: string };
    onBack: () => void;
    onOpenFileTools: () => void;
    onApplied?: () => Promise<void>;
    fileReader?: () => ReactNode;
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
      {fileReader ? (
        fileReader()
      ) : (
        <button type="button" onClick={onOpenFileTools}>
          文件工具
        </button>
      )}
      <button type="button" data-testid="refresh-after-applied" onClick={() => void onApplied?.()}>
        已确认写回，刷新正文
      </button>
    </div>
  ),
}));

describe('F307 File owner collaboration entry', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.canEdit = false;
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
    localStorage.clear();
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

  it.each(['cover.png'])('v2 opens %s with annotations by default and can switch back', async (path) => {
    writeShellPresentation('v2');
    await render(path);
    expect(container.querySelector('[data-testid="workspace-content-review"]')).not.toBeNull();
    await act(async () =>
      [...container.querySelectorAll('button')].find((button) => button.textContent === '文件工具')!.click(),
    );
    expect(container.querySelector('[data-testid="workspace-file-viewer"]')).not.toBeNull();
    await act(async () =>
      [...container.querySelectorAll('button')].find((button) => button.textContent === '协作批注')!.click(),
    );
    expect(container.querySelector('[data-testid="workspace-content-review"]')).not.toBeNull();
  });

  it('v2 code keeps ordinary viewing even when the file is editable and collaboration is available', async () => {
    writeShellPresentation('v2');
    mocks.canEdit = true;
    await render('source.ts');
    expect(container.querySelector('[data-testid="workspace-file-viewer"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="workspace-content-review"]')).toBeNull();
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === '协作批注')).toBe(true);
  });

  it.each([
    'file-tree',
    'chat-file-link',
  ] as const)('DOCX opened from %s reads first and only explicitly enters its original Office owner', async (kind) => {
    writeShellPresentation('v2');
    await act(async () =>
      root.render(
        <F307FileOwnerSurface
          surface={createFileSurface({
            worktreeId: 'worktree-a',
            path: 'docs/report.docx',
            navigationOrigin:
              kind === 'file-tree'
                ? { kind: 'file-tree', worktreeId: 'worktree-a' }
                : { kind: 'chat-file-link', threadId: 'thread-1', messageId: 'message-1' },
          })}
          onRequestDetach={vi.fn()}
        />,
      ),
    );
    expect(container.querySelector('[data-testid="workspace-file-viewer"]')).not.toBeNull();
    expect(mocks.apiFetch.mock.calls.some(([url]) => url === '/api/workspace/content-editor')).toBe(false);
    const edit = [...container.querySelectorAll('button')].find((button) => button.textContent === '协作编辑');
    expect(edit).toBeDefined();
    await act(async () => edit?.click());
    expect(mocks.apiFetch.mock.calls.some(([url]) => url === '/api/workspace/content-editor')).toBe(true);
  });

  it.each([
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
    expect(container.querySelector('[data-testid="workspace-file-viewer"]')).not.toBeNull();
  });

  it('keeps the same collaboration instance while confirmed writeback refreshes its file', async () => {
    await render('notes.md');
    const review = container.querySelector<HTMLElement>('[data-testid="workspace-content-review"]');
    let resolve: (value: Response) => void = () => {};
    mocks.apiFetch.mockImplementationOnce(
      () =>
        new Promise<Response>((finish) => {
          resolve = finish;
        }),
    );
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="refresh-after-applied"]')?.click());
    expect(container.querySelector('[data-testid="workspace-content-review"]')).toBe(review);
    await act(async () =>
      resolve(
        new Response(
          JSON.stringify({
            path: 'notes.md',
            content: '# Updated source',
            sha256: 'written-sha',
            size: 16,
            mime: 'text/markdown',
          }),
        ),
      ),
    );
    expect(container.querySelector('[data-testid="workspace-content-review"]')).toBe(review);
    expect(review?.dataset.source).toBe('# Updated source');
    expect(review?.dataset.revision).toBe('sha256:written-sha');
  });

  it('removes the cached collaboration contents when the refresh is denied', async () => {
    await render('notes.md');
    mocks.apiFetch.mockResolvedValueOnce(new Response('{}', { status: 403 }));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="refresh-after-applied"]')?.click());
    expect(container.querySelector('[data-testid="workspace-content-review"]')).toBeNull();
    expect(container.textContent).toContain('暂时无法读取此文件');
    expect(container.textContent).not.toContain('The source body.');
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
    const back = [...container.querySelectorAll('button')].find((button) => button.textContent === '‹ 工具搜索');
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
    expect(container.querySelector('[data-testid="workspace-file-viewer"]')).not.toBeNull();
  });
  it.each([
    'plugin_not_installed',
    'plugin_disabled',
    'plugin_stopped',
  ])('DOCX retains its source return and common landing when its provider is %s', async (code) => {
    mocks.apiFetch.mockImplementation(async (url: string) =>
      url === '/api/workspace/content-editor'
        ? new Response(JSON.stringify({ error: { code } }), { status: 409 })
        : new Response(
            JSON.stringify({
              path: 'docs/说明书.docx',
              content: '',
              sha256: 'office-bytes',
              size: 25,
              mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              binary: true,
              truncated: false,
            }),
          ),
    );
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
    expect(container.querySelector('[data-testid="workspace-file-viewer"]')).not.toBeNull();
    const edit = [...container.querySelectorAll('button')].find((button) => button.textContent === '协作编辑');
    await act(async () => edit?.click());
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/settings?s=plugins');
    expect(mocks.apiFetch.mock.calls.some(([url]) => url === '/api/workspace/content-editor')).toBe(true);
    const back = [...container.querySelectorAll('button')].find((button) => button.textContent === '‹ 文档');
    expect(back).toBeDefined();
    await act(async () => back?.click());
    expect(container.querySelector('[data-testid="workspace-file-viewer"]')).not.toBeNull();
    await act(async () =>
      [...container.querySelectorAll('button')].find((button) => button.textContent === '返回原来源')?.click(),
    );
    expect(onReturn).toHaveBeenCalledWith(origin);
  });
});
