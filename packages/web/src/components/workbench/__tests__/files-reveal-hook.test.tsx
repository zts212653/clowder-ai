import { act, useCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreeNode } from '@/hooks/useWorkspace';
import { type FilesRevealState, type SubtreeLoad, useFilesReveal } from '../files-tree';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://api.test', apiFetch: mocks.apiFetch }));

const dir = (path: string, children?: TreeNode[]): TreeNode => ({
  name: path.split('/').at(-1) ?? path,
  path,
  type: 'directory',
  ...(children ? { children } : {}),
});
const file = (path: string): TreeNode => ({ name: path.split('/').at(-1) ?? path, path, type: 'file' });

/** An owner answer the test releases when it chooses. */
function deferredAnswer() {
  let release!: (response: Response) => void;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('useFilesReveal: answers against a tree that keeps changing', () => {
  let container: HTMLDivElement;
  let root: Root;
  let seen: FilesRevealState;
  let history: FilesRevealState['status'][];
  const loadSubtree = vi.fn<(path: string) => Promise<SubtreeLoad>>(async () => ({ ok: true }));

  function Harness({ tree, path }: { tree: TreeNode[]; path: string }) {
    const expand = useCallback(() => undefined, []);
    seen = useFilesReveal({
      worktreeId: 'wt-1',
      target: { path, request: 1 },
      tree,
      rootState: 'loaded',
      loadSubtree,
      expand,
    });
    if (history.at(-1) !== seen.status) history.push(seen.status);
    return null;
  }
  async function render(tree: TreeNode[], path: string) {
    await act(async () => root.render(<Harness tree={tree} path={path} />));
    await flush();
  }
  async function flush() {
    for (let i = 0; i < 6; i += 1) await act(async () => Promise.resolve());
  }

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    history = [];
    mocks.apiFetch.mockReset();
    loadSubtree.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // Review P1 (#4741): an older owner answer for the same request must not undo a tree that now shows it.
  it('keeps a reveal the tree has already shown when the older owner answer arrives afterwards', async () => {
    const probe = deferredAnswer();
    mocks.apiFetch.mockReturnValue(probe.promise);
    await render([dir('docs', [])], 'docs/new');
    expect(seen.status).toBe('revealing');

    await render([dir('docs', [dir('docs/new', [])])], 'docs/new');
    expect(seen).toMatchObject({ status: 'revealed', selected: 'docs/new' });

    await act(async () => probe.release(new Response('{}', { status: 404 })));
    await flush();
    expect(seen).toMatchObject({ status: 'revealed', selected: 'docs/new' });
    // Not even for one render: once shown, the path is never reported as missing.
    expect(history.slice(history.indexOf('revealed'))).not.toContain('failed');
  });

  it('turns a reported failure into the reveal once the tree actually shows the path', async () => {
    mocks.apiFetch.mockResolvedValue(new Response('{}', { status: 404 }));
    await render([dir('docs', [])], 'docs/new');
    expect(seen.status).toBe('failed');

    await render([dir('docs', [dir('docs/new', [])])], 'docs/new');
    expect(seen).toMatchObject({ status: 'revealed', selected: 'docs/new' });
  });

  // Review P1 (#4741): the worktree root is the tree itself, not a child the root listing lacks.
  it('shows the worktree root without asking the owner anything', async () => {
    await render([file('README.md')], '.');
    expect(seen).toEqual({ status: 'revealed', path: '', selected: '' });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('lists the parent again when the owner can list a path the older listing lacked', async () => {
    mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ tree: [], hiddenFromTree: false })));
    await render([dir('docs', [])], 'docs/new');
    expect(loadSubtree).toHaveBeenCalledWith('docs');
    expect(seen.status).toBe('revealing');

    await render([dir('docs', [dir('docs/new', [])])], 'docs/new');
    expect(seen).toMatchObject({ status: 'revealed', selected: 'docs/new' });
  });

  it("reports the tree's own hiding rule only when the owner says so", async () => {
    mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ tree: [], hiddenFromTree: true })));
    await render([file('README.md')], '.cat-cafe/logs');
    expect(seen).toMatchObject({ status: 'failed' });
    expect(seen.status === 'failed' && seen.reason).toContain('.cat-cafe 存在，但文件树不显示');
    expect(loadSubtree).not.toHaveBeenCalled();
  });

  it('stops after one fresh listing when the owner keeps saying listable but the listing never shows it', async () => {
    mocks.apiFetch.mockImplementation(async () => new Response(JSON.stringify({ tree: [], hiddenFromTree: false })));
    await render([dir('docs', [])], 'docs/new');
    await render([dir('docs', [])], 'docs/new');
    expect(loadSubtree).toHaveBeenCalledTimes(1);
    expect(seen.status === 'failed' && seen.reason).toContain('暂时无法确认 docs/new');
  });
});
