import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreeNode } from '@/hooks/useWorkspace';
import { F307FilesOwnerSurface } from '../F307FilesOwnerSurface';
import { createFilesSurface } from '../real-surface-adapters';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://api.test', apiFetch: mocks.apiFetch }));
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

const dir = (path: string, children?: TreeNode[]): TreeNode => ({
  name: path.split('/').at(-1) ?? path,
  path,
  type: 'directory',
  ...(children ? { children } : {}),
});
const file = (path: string): TreeNode => ({ name: path.split('/').at(-1) ?? path, path, type: 'file' });

/** The tree route's own rule for entries a listing leaves out (mirrors workspace.ts `hiddenFromTree`). */
const hiddenByTree = (path: string) =>
  path.split('/').some((name) => (name.startsWith('.') && name !== '.kimi') || name === 'node_modules');

/**
 * The owner as the tree route answers it: listings by sub-path (a sub-path answer carries hiddenFromTree),
 * or a status for a path it will not list. A listing may be a function to change between reads.
 */
function owner(listings: Record<string, TreeNode[] | (() => TreeNode[])>, statuses: Record<string, number> = {}) {
  mocks.apiFetch.mockImplementation(async (url: string) => {
    const parsed = new URL(url, 'http://web.test');
    if (parsed.pathname === '/api/workspace/worktrees') {
      return new Response(JSON.stringify({ worktrees: [{ id: 'wt-1', root: '/repo', branch: 'main', head: 'abc' }] }));
    }
    if (parsed.pathname !== '/api/workspace/tree') throw new Error(`unexpected route ${url}`);
    const path = parsed.searchParams.get('path') ?? '';
    if (statuses[path]) return new Response(JSON.stringify({ error: 'x' }), { status: statuses[path] });
    const listing = listings[path];
    if (!listing) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    const tree = typeof listing === 'function' ? listing() : listing;
    return new Response(JSON.stringify(path ? { tree, hiddenFromTree: hiddenByTree(path) } : { tree }));
  });
}

describe('F307 Files owner surface reveal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(path: string, onReturnToNavigationOrigin?: () => void) {
    const surface = createFilesSurface('wt-1', { reveal: { path, request: 1 } });
    await act(async () => {
      root.render(
        <F307FilesOwnerSurface
          surface={surface}
          onOpenSurface={vi.fn()}
          onReturnToNavigationOrigin={onReturnToNavigationOrigin}
        />,
      );
    });
    for (let i = 0; i < 8; i += 1) await act(async () => Promise.resolve());
  }
  const status = () => container.querySelector('[data-testid="f307-files-reveal"]');
  const row = (path: string) => container.querySelector<HTMLButtonElement>(`button[title="${path}"]`);

  it('shows a directory: its chain expands, it is marked current, and its contents are listed', async () => {
    owner({
      '': [dir('packages', [dir('packages/api', [dir('packages/api/uploads'), file('packages/api/a.ts')])])],
      'packages/api/uploads': [file('packages/api/uploads/photo.png')],
    });
    await render('packages/api/uploads');
    expect(status()?.getAttribute('data-reveal-status')).toBe('revealed');
    expect(status()?.textContent).toBe('已定位：packages/api/uploads');
    expect(row('packages/api/uploads')?.getAttribute('aria-current')).toBe('true');
    expect(row('packages/api/uploads/photo.png')).not.toBeNull();
  });

  it('loads the unlisted levels on the way to a deep directory', async () => {
    owner({
      '': [dir('packages', [dir('packages/api', [dir('packages/api/data')])])],
      'packages/api/data': [dir('packages/api/data/logs', [dir('packages/api/data/logs/api', [])])],
    });
    await render('packages/api/data/logs/api');
    expect(status()?.getAttribute('data-reveal-status')).toBe('revealed');
    expect(row('packages/api/data/logs/api')?.getAttribute('aria-current')).toBe('true');
  });

  it("says a missing directory does not exist, from the owner's own answer", async () => {
    owner({ '': [dir('packages', [dir('packages/api', [])])] });
    await render('packages/api/uploads');
    expect(status()?.getAttribute('role')).toBe('alert');
    expect(status()?.textContent).toContain('工作区里没有 packages/api/uploads');
  });

  it('says a directory exists but is hidden when the owner can list it and the tree does not show it', async () => {
    owner({ '': [file('README.md')], '.cat-cafe': [] });
    await render('.cat-cafe/logs');
    expect(status()?.textContent).toContain('.cat-cafe 存在，但文件树不显示');
  });

  it('shows the worktree root as located, without marking any row', async () => {
    owner({ '': [file('README.md')] });
    await render('.');
    expect(status()?.textContent).toBe('已定位：工作区根目录');
    expect(container.querySelector('[aria-current="true"]')).toBeNull();
  });

  it('finds a top-level directory created after the tree was listed by listing the root again', async () => {
    let rootReads = 0;
    owner({
      '': () => (rootReads++ === 0 ? [file('README.md')] : [file('README.md'), dir('fresh-dir', [])]),
      'fresh-dir': [],
    });
    await render('fresh-dir');
    expect(status()?.getAttribute('data-reveal-status')).toBe('revealed');
    expect(row('fresh-dir')?.getAttribute('aria-current')).toBe('true');
  });

  it('says a protected directory is protected', async () => {
    owner({ '': [dir('secrets')] }, { secrets: 403 });
    await render('secrets/keys');
    expect(status()?.textContent).toContain('secrets 受工作区安全策略保护');
  });

  it('offers the way back only when the tree was opened from an entry that has one', async () => {
    owner({ '': [dir('docs', [])] });
    const back = vi.fn();
    await render('docs', back);
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent === '返回来源');
    await act(async () => button?.click());
    expect(back).toHaveBeenCalledTimes(1);

    await render('docs');
    expect([...container.querySelectorAll('button')].some((item) => item.textContent === '返回来源')).toBe(false);
  });
});
