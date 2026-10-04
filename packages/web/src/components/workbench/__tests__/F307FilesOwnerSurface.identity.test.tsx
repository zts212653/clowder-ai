import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { F307FilesOwnerSurface } from '../F307FilesOwnerSurface';
import { createFilesSurface, resolveFilesTarget, resolveFileTarget } from '../real-surface-adapters';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://localhost:3102', apiFetch: mocks.apiFetch }));
vi.mock('@/hooks/useFileManagement', () => ({
  useFileManagement: () => ({
    createFile: vi.fn(),
    createDir: vi.fn(),
    deleteItem: vi.fn(),
    renameItem: vi.fn(),
    uploadFile: vi.fn(),
  }),
}));
vi.mock('@/components/useConfirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));
vi.mock('@/components/workspace/WorkspaceTree', () => ({
  WorkspaceTree: ({ onSelect }: { onSelect: (path: string) => void }) => (
    <button type="button" data-testid="select-owner-file" onClick={() => onSelect('packages/api/uploads/a.png')}>
      a.png
    </button>
  ),
}));

// Parent Alpha 2026-09-25: Settings → 上传目录 → the tree listed its contents, but the header stayed
// "请选择工作区" / branch "读取中…" because identity was looked up under the chat's project, not Alpha's root.
const ALPHA_ROOT = '/home/user/cat-cafe-alpha';
const ALPHA_ID = 'b603ff_cat-cafe-alpha';
const alphaListing = `/api/workspace/worktrees?${new URLSearchParams({ repoRoot: ALPHA_ROOT })}`;
const alphaEntry = {
  id: ALPHA_ID,
  canonicalId: 'cat-cafe-alpha',
  root: ALPHA_ROOT,
  branch: 'main',
  head: '69c41632',
};

type Listing = { ok: boolean; status?: number; worktrees?: unknown[]; raw?: unknown };

describe('F307 Files owner surface: worktree identity through the coordinate that minted it', () => {
  let container: HTMLDivElement;
  let root: Root;
  let listings: Record<string, Listing[]>;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    listings = {};
    mocks.apiFetch.mockReset().mockImplementation(async (url: string) => {
      if (url.startsWith('/api/workspace/tree?')) return { ok: true, json: async () => ({ tree: [] }) };
      const queue = listings[url];
      const next = queue && queue.length > 1 ? queue.shift() : queue?.[0];
      if (!next) throw new Error(`Unexpected API call: ${url}`);
      return {
        ok: next.ok,
        status: next.status ?? 200,
        json: async () => (next.raw !== undefined ? next.raw : { worktrees: next.worktrees ?? [] }),
      };
    });
    // Settings opens the lobby thread when the clicked chat is another project.
    useChatStore.setState({ currentProjectPath: 'default', currentThreadId: 'default', pendingChatInsert: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const listingCalls = () =>
    mocks.apiFetch.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('/api/workspace/worktrees'));
  const header = () => container.querySelector('[data-testid="f307-files-worktree-identity"]')?.textContent ?? '';
  const status = () => container.querySelector('[data-testid="f307-files-worktree-identity-status"]');
  const head = () => container.querySelector('[data-testid="f307-files-worktree-head"]')?.textContent;
  const select = () => container.querySelector<HTMLSelectElement>('[data-testid="f307-files-worktree-select"]');

  async function render(onOpenSurface = vi.fn(), surface = createFilesSurface(ALPHA_ID, { repoRoot: ALPHA_ROOT })) {
    await act(async () => {
      root.render(<F307FilesOwnerSurface surface={surface} onOpenSurface={onOpenSurface} />);
    });
    for (let i = 0; i < 3; i += 1) await act(async () => Promise.resolve());
    return onOpenSurface;
  }

  it('a Settings tree shows its branch and HEAD from its own root, not the current chat', async () => {
    listings[alphaListing] = [{ ok: true, worktrees: [alphaEntry] }];
    await render();
    expect(listingCalls()).toEqual([alphaListing]);
    expect(header()).toContain('main');
    expect(header()).toContain('69c41632');
    expect(header()).toContain(ALPHA_ROOT);
    expect(header()).not.toContain('请选择工作区');
    expect(header()).not.toContain('读取中');
    expect(status()).toBeNull();
  });

  it('an id its listing does not name ends as unknown with a reason, never "choose a workspace"', async () => {
    listings[alphaListing] = [
      { ok: true, worktrees: [{ ...alphaEntry, id: 'b603ff_other', canonicalId: 'other' }] },
      { ok: true, worktrees: [alphaEntry] },
    ];
    await render();
    const select = container.querySelector<HTMLSelectElement>('[data-testid="f307-files-worktree-select"]');
    expect(select?.value).toBe(ALPHA_ID);
    expect(header()).not.toContain('请选择工作区');
    expect(header()).not.toContain('读取中');
    expect(header()).toContain('未知');
    expect(status()?.getAttribute('data-identity-state')).toBe('unlisted');

    await act(async () =>
      [...container.querySelectorAll('button')].find((button) => button.textContent === '重新读取')?.click(),
    );
    for (let i = 0; i < 3; i += 1) await act(async () => Promise.resolve());
    expect(listingCalls()).toEqual([alphaListing, alphaListing]);
    expect(header()).toContain('69c41632');
    expect(status()).toBeNull();
  });

  it('a failed identity read says so instead of loading forever', async () => {
    listings[alphaListing] = [{ ok: false, status: 500 }];
    await render();
    expect(header()).toContain('读取失败');
    expect(header()).not.toContain('读取中');
    expect(status()?.getAttribute('data-identity-state')).toBe('failed');
  });

  // Sol #4749 review P1: an explicit coordinate names one exact id; an alias match is another worktree.
  it('under an explicit root, an alias of another id is never borrowed as this tree’s identity', async () => {
    const foreign = `/api/workspace/worktrees?${new URLSearchParams({ repoRoot: '/foreign' })}`;
    listings[foreign] = [
      {
        ok: true,
        worktrees: [
          {
            id: 'b603ff_cat-cafe',
            canonicalId: 'cat-cafe',
            root: '/foreign',
            resolvedRoot: '/foreign',
            rootEpoch: 0,
            branch: 'wrong-branch',
            head: 'wronghead',
          },
        ],
      },
    ];
    const onOpenSurface = await render(vi.fn(), createFilesSurface('cat-cafe', { repoRoot: '/foreign' }));
    // The foreign entry may be listed as a choice, but it never becomes this tree's branch/HEAD.
    expect(head()).toBe('未知');
    expect(select()?.value).toBe('cat-cafe');
    expect(status()?.getAttribute('data-identity-state')).toBe('unlisted');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="select-owner-file"]')?.click());
    expect(onOpenSurface.mock.calls[0]?.[0]?.rootSelection).toBeUndefined();
  });

  // Sol #4749 review P1: a response whose shape cannot be read proves nothing about the list.
  it.each([
    ['an empty object', {}],
    ['a non-array worktrees field', { worktrees: 'not-a-list' }],
  ])('a 200 with %s is a failed read, not "not listed"', async (_name, raw) => {
    listings[alphaListing] = [{ ok: true, raw }];
    await render();
    expect(status()?.getAttribute('data-identity-state')).toBe('failed');
    expect(header()).toContain('读取失败');
  });

  // Sol #4749 R3 P1: an entry whose fields cannot be read is not a known identity, and a partial list is not a list.
  it.each([
    ['only an id', { id: ALPHA_ID }],
    ['no root', { ...alphaEntry, root: undefined }],
    ['no branch', { ...alphaEntry, branch: undefined }],
    ['an empty branch', { ...alphaEntry, branch: '' }],
    ['no head', { ...alphaEntry, head: undefined }],
    ['a numeric head', { ...alphaEntry, head: 69 }],
    ['a string removable', { ...alphaEntry, removable: 'yes' }],
    ['a string connection epoch', { ...alphaEntry, connectionEpoch: '3' }],
    ['a negative root epoch', { ...alphaEntry, resolvedRoot: ALPHA_ROOT, rootEpoch: -1 }],
    ['a non-string resolved root', { ...alphaEntry, resolvedRoot: 42, rootEpoch: 0 }],
    ['aliases that are not a list of ids', { ...alphaEntry, legacyAliases: 'cat-cafe-alpha' }],
    ['a numeric canonical id', { ...alphaEntry, canonicalId: 7 }],
  ])('a target entry with %s fails the read instead of rendering as known', async (_name, entry) => {
    listings[alphaListing] = [{ ok: true, worktrees: [entry] }];
    await render();
    expect(container.querySelector('[data-testid="f307-files-owner-surface"]')).not.toBeNull();
    expect(status()?.getAttribute('data-identity-state')).toBe('failed');
    expect(head()).toBe('读取失败');
    expect(select()?.options).toHaveLength(1);
  });

  it('one malformed sibling fails the whole read: a partial list never confirms the target', async () => {
    listings[alphaListing] = [{ ok: true, worktrees: [alphaEntry, { id: 'b603ff_broken', root: '/b' }] }];
    await render();
    expect(status()?.getAttribute('data-identity-state')).toBe('failed');
    expect(head()).toBe('读取失败');
  });

  // The server's own "no HEAD" (a bare repository in `git worktree list`) is an answer, not a malformed entry.
  it('a bare repository entry with no HEAD does not fail its siblings, and shows as having no HEAD', async () => {
    const bare = {
      id: 'b603ff_alpha_git',
      canonicalId: 'alpha_git',
      root: '/home/user/alpha.git',
      branch: 'HEAD',
      head: '',
    };
    listings[alphaListing] = [{ ok: true, worktrees: [bare, alphaEntry] }];
    await render();
    expect(status()).toBeNull();
    expect(head()).toBe('69c41632');
    listings[alphaListing] = [{ ok: true, worktrees: [bare, alphaEntry] }];
    await render(vi.fn(), createFilesSurface(bare.id, { repoRoot: ALPHA_ROOT }));
    expect(status()).toBeNull();
    expect(head()).toBe('无 HEAD');
    // Sol #4749 R3 P2: the selector on the same surface says the same thing, never "HEAD ()".
    const options = Array.from(select()?.options ?? [], (option) => option.textContent);
    expect(options).toContain('alpha.git — HEAD (无 HEAD)');
    expect(options.join('\n')).not.toContain('()');
  });

  it('a legacy tree whose id two entries claim is ambiguous, not "not listed"', async () => {
    listings['/api/workspace/worktrees'] = [
      {
        ok: true,
        worktrees: [
          { id: 'a1_cat-cafe', canonicalId: 'cat-cafe', root: '/a', branch: 'one', head: '111' },
          { id: 'b2_cat-cafe', canonicalId: 'cat-cafe', root: '/b', branch: 'two', head: '222' },
        ],
      },
    ];
    await render(vi.fn(), createFilesSurface('cat-cafe'));
    expect(status()?.getAttribute('data-identity-state')).toBe('ambiguous');
    expect(header()).not.toContain('不在对应项目的工作区列表里');
    expect(head()).toBe('无法确认');
  });

  it('files opened from this tree and worktree switches keep its coordinate', async () => {
    const sibling = { ...alphaEntry, id: 'b603ff_cat-cafe-alpha-2', canonicalId: 'alpha-2', branch: 'feat/x' };
    listings[alphaListing] = [{ ok: true, worktrees: [alphaEntry, sibling] }];
    const onOpenSurface = await render();

    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="select-owner-file"]')?.click());
    const opened = onOpenSurface.mock.calls[0]?.[0];
    expect(resolveFileTarget(opened)?.path).toBe('packages/api/uploads/a.png');
    expect(opened?.navigationOrigin).toEqual({ kind: 'file-tree', worktreeId: ALPHA_ID, repoRoot: ALPHA_ROOT });

    const select = container.querySelector<HTMLSelectElement>('[data-testid="f307-files-worktree-select"]');
    await act(async () => {
      if (!select) return;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, sibling.id);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(resolveFilesTarget(onOpenSurface.mock.calls[1]?.[0])).toEqual({
      worktreeId: sibling.id,
      repoRoot: ALPHA_ROOT,
    });
  });
});
