import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreeCallbacks } from '@/components/workspace/WorkspaceTree';
import { useChatStore } from '@/stores/chatStore';
import { F307FileOwnerSurface } from '../F307FileOwnerSurface';
import { F307FilesOwnerSurface } from '../F307FilesOwnerSurface';
import {
  createFileSurface,
  createWorkspaceDestinationSurface,
  resolveFilesTarget,
  resolveFileTarget,
} from '../real-surface-adapters';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  createFile: vi.fn(),
  createDir: vi.fn(),
  deleteItem: vi.fn(),
  renameItem: vi.fn(),
  uploadFile: vi.fn(),
  useFileManagement: vi.fn(),
}));

vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/hooks/useFileManagement', () => ({ useFileManagement: mocks.useFileManagement }));
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
  WorkspaceFileViewer: ({ scrollToLine }: { scrollToLine: number | null }) => (
    <div data-testid="file-viewer" data-scroll-to-line={scrollToLine ?? ''} />
  ),
}));
vi.mock('@/components/useConfirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));
vi.mock('@/components/workspace/WorkspaceTree', () => ({
  WorkspaceTree: ({
    onSelect,
    onCite,
    callbacks,
  }: {
    onSelect: (path: string) => void;
    onCite?: (path: string) => void;
    callbacks?: TreeCallbacks;
  }) => (
    <div>
      <button type="button" data-testid="select-owner-file" onClick={() => onSelect('src/owner.ts')}>
        owner.ts
      </button>
      <button type="button" data-testid="cite-owner-file" onClick={() => onCite?.('src/owner.ts')}>
        cite owner.ts
      </button>
      <button
        type="button"
        data-testid="create-owner-file"
        onClick={() => void callbacks?.onCreateFile?.('src', 'new.ts')}
      >
        create new.ts
      </button>
    </div>
  ),
}));

function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
}

function createFilesSurface() {
  const surface = createWorkspaceDestinationSurface(
    {
      kind: 'surface',
      id: 'files',
      label: '文件与代码',
      description: '浏览与打开工作区文件',
      searchTerms: 'files tree source',
    },
    'thread-a',
    'worktree-owner',
  );
  if (!surface) throw new Error('Files destination requires a persisted worktree owner');
  return surface;
}

describe('F307 Files owner surface', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.createFile.mockReset().mockResolvedValue({ ok: true });
    mocks.createDir.mockReset();
    mocks.deleteItem.mockReset();
    mocks.renameItem.mockReset();
    mocks.uploadFile.mockReset();
    mocks.useFileManagement.mockReset().mockReturnValue({
      createFile: mocks.createFile,
      createDir: mocks.createDir,
      deleteItem: mocks.deleteItem,
      renameItem: mocks.renameItem,
      uploadFile: mocks.uploadFile,
    });
    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/workspace/worktrees?repoRoot=%2Frepo%2Fcat-cafe') {
        return {
          ok: true,
          json: async () => ({
            worktrees: [
              {
                id: 'worktree-owner',
                canonicalId: 'cat-cafe',
                root: '/repo/cat-cafe',
                branch: 'main',
                head: 'abc123',
              },
              {
                id: 'worktree-feature',
                canonicalId: 'cat-cafe-feature',
                root: '/repo/cat-cafe-feature',
                branch: 'feat/selector',
                head: 'def456',
              },
            ],
          }),
        };
      }
      if (url === '/api/workspace/tree?worktreeId=worktree-owner&depth=3') {
        return { ok: true, json: async () => ({ tree: [] }) };
      }
      if (url === '/api/workspace/search' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { type: string };
        return {
          ok: true,
          json: async () => ({
            results:
              body.type === 'filename'
                ? [{ path: 'src/owner.ts', line: 0, content: '', contextBefore: '', contextAfter: '' }]
                : [{ path: 'src/owner.ts', line: 17, content: 'owner result', contextBefore: '', contextAfter: '' }],
          }),
        };
      }
      throw new Error(`Unexpected API call: ${url}`);
    });
    useChatStore.setState({
      currentProjectPath: '/repo/cat-cafe',
      currentThreadId: 'thread-a',
      workspaceWorktreeId: 'ambient-worktree',
      pendingChatInsert: null,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('restores inline search and exposes the exact worktree branch and root', async () => {
    const onOpenSurface = vi.fn();

    await act(async () => {
      root.render(<F307FilesOwnerSurface surface={createFilesSurface()} onOpenSurface={onOpenSurface} />);
    });

    expect(container.textContent).toContain('cat-cafe');
    expect(container.textContent).toContain('main');
    expect(container.textContent).toContain('/repo/cat-cafe');
    expect(container.textContent).toContain('abc123');
    const input = container.querySelector<HTMLInputElement>('[data-testid="f307-files-search-input"]');
    expect(input).not.toBeNull();

    await act(async () => {
      if (!input) return;
      setNativeValue(input, 'owner');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector<HTMLFormElement>('[data-testid="f307-files-search-form"]')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/workspace/search',
      expect.objectContaining({
        body: JSON.stringify({ worktreeId: 'worktree-owner', query: 'owner', type: 'filename' }),
      }),
    );
    expect(container.textContent).toContain('内容匹配 (1)');
    const contentResult = container.querySelector<HTMLButtonElement>('[data-search-result-line="17"]');
    await act(async () => contentResult?.click());
    expect(resolveFileTarget(onOpenSurface.mock.calls[0]?.[0])).toEqual({
      worktreeId: 'worktree-owner',
      path: 'src/owner.ts',
      scrollToLine: 17,
    });
  });

  it('switches the persisted F307 Files owner through the worktree branch and HEAD selector', async () => {
    const onOpenSurface = vi.fn();

    await act(async () => {
      root.render(<F307FilesOwnerSurface surface={createFilesSurface()} onOpenSurface={onOpenSurface} />);
    });

    const selector = container.querySelector<HTMLSelectElement>('[data-testid="f307-files-worktree-select"]');
    expect(selector).not.toBeNull();
    expect(selector?.value).toBe('worktree-owner');
    expect(selector?.textContent).toContain('cat-cafe — main (abc123)');
    expect(selector?.textContent).toContain('cat-cafe-feature — feat/selector (def456)');

    await act(async () => {
      if (!selector) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(selector, 'worktree-feature');
      selector.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(useChatStore.getState().workspaceWorktreeId).toBe('worktree-feature');
    expect(resolveFilesTarget(onOpenSurface.mock.calls[0]?.[0])).toEqual({ worktreeId: 'worktree-feature' });
  });

  it('passes a persisted content-search line through to the file viewer', async () => {
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        path: 'src/owner.ts',
        content: 'line 1\nline 2',
        sha256: 'abc123',
        size: 13,
        mime: 'text/plain',
        truncated: false,
      }),
    });

    await act(async () => {
      root.render(
        <F307FileOwnerSurface
          surface={createFileSurface({
            worktreeId: 'worktree-owner',
            path: 'src/owner.ts',
            scrollToLine: 17,
          })}
          onRequestDetach={() => undefined}
        />,
      );
    });

    expect(container.querySelector('[data-testid="file-viewer"]')?.getAttribute('data-scroll-to-line')).toBe('17');
  });

  it('binds restored file actions and citation to the persisted owner instead of ambient workspace state', async () => {
    const onOpenSurface = vi.fn();
    await act(async () => {
      root.render(<F307FilesOwnerSurface surface={createFilesSurface()} onOpenSurface={onOpenSurface} />);
    });

    expect(mocks.useFileManagement).toHaveBeenCalledWith('worktree-owner');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="create-owner-file"]')?.click());
    expect(mocks.createFile).toHaveBeenCalledWith('src/new.ts');
    expect(onOpenSurface).toHaveBeenCalledWith(
      expect.objectContaining({
        resultTargetRef: { owner: 'f063-workspace-file', key: 'worktree-owner:src/new.ts' },
      }),
    );

    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="cite-owner-file"]')?.click());
    expect(useChatStore.getState().pendingChatInsert).toMatchObject({
      threadId: 'thread-a',
      contextAttachments: [
        { kind: 'workspace_file', path: 'src/owner.ts', worktreeId: 'worktree-owner', branch: 'main' },
      ],
    });
  });
});
