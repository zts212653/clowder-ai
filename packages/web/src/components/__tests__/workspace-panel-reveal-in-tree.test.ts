import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/* ---- Hoisted mocks ---- */
const mocks = vi.hoisted(() => ({
  useWorkspace: vi.fn(),
  useFileManagement: vi.fn(),
  useChatStore: vi.fn(),
  apiFetch: vi.fn(),
  usePersistedState: vi.fn(),
}));

vi.mock('@/hooks/useWorkspace', () => ({
  useWorkspace: (...args: unknown[]) => mocks.useWorkspace(...args),
}));
vi.mock('@/hooks/useFileManagement', () => ({
  useFileManagement: (...args: unknown[]) => mocks.useFileManagement(...args),
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (sel: (s: Record<string, unknown>) => unknown) => mocks.useChatStore(sel),
}));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:3004',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('@/hooks/usePersistedState', () => ({
  usePersistedState: (...args: unknown[]) => mocks.usePersistedState(...args),
}));

vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: () => React.createElement('div', { 'data-testid': 'markdown' }),
}));
vi.mock('@/components/workspace/ChangesPanel', () => ({ ChangesPanel: () => null }));
vi.mock('@/components/workspace/GitPanel', () => ({ GitPanel: () => null }));
vi.mock('@/components/workspace/TerminalTab', () => ({ TerminalTab: () => null }));
vi.mock('@/components/workspace/JsxPreview', () => ({ JsxPreview: () => null }));
vi.mock('@/components/workspace/LinkedRootsManager', () => ({
  LinkedRootsManager: () => null,
  LinkedRootRemoveButton: () => null,
}));
vi.mock('@/components/workspace/CodeViewer', () => ({
  CodeViewer: () => React.createElement('div', { 'data-testid': 'code-viewer' }),
}));
vi.mock('@/components/workspace/FileIcons', () => ({ FileIcon: () => null }));
vi.mock('@/components/workspace/ResizeHandle', () => ({ ResizeHandle: () => null }));

/* WorkspaceTree: render expanded paths as data attributes so we can assert */
vi.mock('@/components/workspace/WorkspaceTree', () => ({
  WorkspaceTree: (props: { expandedPaths: Set<string> }) =>
    React.createElement('div', {
      'data-testid': 'workspace-tree',
      'data-expanded': JSON.stringify([...props.expandedPaths].sort()),
    }),
}));

/* ---- Tree fixtures ---- */
type TreeNode = { name: string; path: string; type: 'file' | 'directory'; children?: TreeNode[] };

const FULL_TREE: TreeNode[] = [
  {
    name: 'packages',
    path: 'packages',
    type: 'directory',
    children: [
      {
        name: 'web',
        path: 'packages/web',
        type: 'directory',
        children: [
          {
            name: 'src',
            path: 'packages/web/src',
            type: 'directory',
            children: [{ name: 'App.tsx', path: 'packages/web/src/App.tsx', type: 'file' }],
          },
        ],
      },
    ],
  },
];

/** Shallow tree (depth=1): deeper children not yet loaded */
const SHALLOW_TREE: TreeNode[] = [
  {
    name: 'packages',
    path: 'packages',
    type: 'directory',
    children: [
      {
        name: 'web',
        path: 'packages/web',
        type: 'directory',
        children: undefined, // not yet loaded
      },
    ],
  },
];

const SEARCH_RESULTS = [
  { path: 'packages/web/src/App.tsx', line: 10, content: 'function App() {', matchType: 'content' as const },
];

/* ---- Helpers ---- */
function setupWithSearchResults(treeOverride?: TreeNode[]) {
  const setSearchResults = vi.fn();
  const fetchSubtree = vi.fn();
  const setOpenFile = vi.fn();

  const workspaceValue = {
    worktrees: [{ id: 'main', branch: 'main', root: '/tmp/repo', isBare: false, isMain: true }],
    worktreeId: 'main',
    tree: treeOverride ?? FULL_TREE,
    file: null,
    searchResults: SEARCH_RESULTS,
    loading: false,
    error: null,
    search: vi.fn(),
    setSearchResults,
    fetchFile: vi.fn(),
    fetchTree: vi.fn(),
    fetchSubtree,
    fetchWorktrees: vi.fn(),
    revealInFinder: vi.fn(),
  };
  mocks.useWorkspace.mockReturnValue(workspaceValue);
  mocks.useFileManagement.mockReturnValue({
    createFile: vi.fn(),
    createDir: vi.fn(),
    deleteItem: vi.fn(),
    renameItem: vi.fn(),
    uploadFile: vi.fn(),
  });
  mocks.useChatStore.mockImplementation((sel: (s: Record<string, unknown>) => unknown) => {
    const store: Record<string, unknown> = {
      workspaceWorktreeId: 'main',
      workspaceOpenFilePath: null,
      workspaceOpenTabs: [],
      currentProjectPath: '/tmp/repo',
      setWorkspaceWorktreeId: vi.fn(),
      setWorkspaceOpenFilePath: vi.fn(),
      setWorkspaceOpenTabs: vi.fn(),
      setWorkspaceOpenFile: setOpenFile,
      workspaceExpanded: true,
      setWorkspaceExpanded: vi.fn(),
      currentWorktree: { id: 'main', branch: 'main', root: '/tmp/repo' },
      _workspaceFileSetAt: { ts: 0, threadId: null },
    };
    return sel(store);
  });
  mocks.usePersistedState.mockImplementation((_key: string, init: unknown) => [init, vi.fn()]);
  return { setSearchResults, fetchSubtree, setOpenFile, workspaceValue };
}

/* ---- Tests ---- */
describe('WorkspacePanel reveal-in-tree', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined), readText: vi.fn() },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('expands ancestor directories when search result is clicked', async () => {
    setupWithSearchResults();
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');

    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    // Find the search result button for App.tsx
    const buttons = container.querySelectorAll('button');
    let searchResultEl: HTMLElement | null = null;
    for (const btn of buttons) {
      if (btn.textContent?.includes('App.tsx') && btn.textContent?.includes('function App')) {
        searchResultEl = btn;
        break;
      }
    }
    expect(searchResultEl).not.toBeNull();

    await act(async () => {
      searchResultEl?.click();
    });

    // Check that WorkspaceTree received expandedPaths with all ancestors
    const treeEl = container.querySelector('[data-testid="workspace-tree"]');
    expect(treeEl).not.toBeNull();
    const expanded = JSON.parse(treeEl?.getAttribute('data-expanded') ?? '[]') as string[];
    expect(expanded).toContain('packages');
    expect(expanded).toContain('packages/web');
    expect(expanded).toContain('packages/web/src');
  });

  it('calls fetchSubtree for unloaded ancestor directories in shallow tree', async () => {
    const { fetchSubtree } = setupWithSearchResults(SHALLOW_TREE);
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');

    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    // Click the search result
    const buttons = container.querySelectorAll('button');
    let searchResultEl: HTMLElement | null = null;
    for (const btn of buttons) {
      if (btn.textContent?.includes('App.tsx') && btn.textContent?.includes('function App')) {
        searchResultEl = btn;
        break;
      }
    }
    expect(searchResultEl).not.toBeNull();

    await act(async () => {
      searchResultEl?.click();
    });

    // fetchSubtree should have been called for the first unloaded directory (packages/web)
    expect(fetchSubtree).toHaveBeenCalledWith('packages/web');

    // Expanded paths should include known ancestors even though deeper ones aren't loaded yet
    const treeEl = container.querySelector('[data-testid="workspace-tree"]');
    expect(treeEl).not.toBeNull();
    const expanded = JSON.parse(treeEl?.getAttribute('data-expanded') ?? '[]') as string[];
    expect(expanded).toContain('packages');
    expect(expanded).toContain('packages/web');
    // packages/web/src not yet expanded because it wasn't in the tree yet — will expand on next tree update
  });
});
