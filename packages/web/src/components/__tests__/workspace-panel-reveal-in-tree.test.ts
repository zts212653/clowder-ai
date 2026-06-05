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
vi.mock('@/components/workspace/BrowserPanel', () => ({
  BrowserPanel: () => React.createElement('div', { 'data-testid': 'browser-panel' }),
}));
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
type WorkspaceFileFixture = {
  path: string;
  content: string;
  size: number;
  modified?: string;
};
type MockWorkspaceValue = Record<string, unknown> & { file: WorkspaceFileFixture | null };

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

  const workspaceValue: MockWorkspaceValue = {
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

function setupWithMutableStore(initialStore: Record<string, unknown>) {
  const store: Record<string, unknown> = {
    workspaceWorktreeId: 'main',
    workspaceOpenFilePath: null,
    workspaceOpenFileLine: null,
    workspaceOpenTabs: [],
    currentProjectPath: '/tmp/repo',
    currentThreadId: 'thread-f223',
    rightPanelMode: 'workspace',
    workspaceMode: 'dev',
    pendingPreviewAutoOpen: null,
    consumePreviewAutoOpen: vi.fn(() => {
      const pending = store.pendingPreviewAutoOpen;
      store.pendingPreviewAutoOpen = null;
      return pending;
    }),
    setWorkspaceWorktreeId: vi.fn((id: string | null) => {
      store.workspaceWorktreeId = id;
    }),
    setWorkspaceOpenFile: vi.fn(),
    setWorkspaceRevealPath: vi.fn((path: string | null) => {
      store.workspaceRevealPath = path;
    }),
    setWorkspaceMode: vi.fn((mode: string) => {
      store.workspaceMode = mode;
    }),
    setRightPanelMode: vi.fn(),
    setPendingChatInsert: vi.fn(),
    enablePresentationLock: vi.fn(),
    disablePresentationLock: vi.fn(),
    setPresentationLockViewport: vi.fn(),
    presentationLock: null,
    workspaceScrollTop: null,
    workspaceRevealPath: null,
    _workspaceFileSetAt: { ts: 0, threadId: null },
    ...initialStore,
  };

  const workspaceValue: MockWorkspaceValue = {
    worktrees: [{ id: 'main', branch: 'main', root: '/tmp/repo', isBare: false, isMain: true }],
    worktreeId: 'main',
    tree: FULL_TREE,
    file: null,
    searchResults: [],
    loading: false,
    searchLoading: false,
    error: null,
    search: vi.fn(),
    setSearchResults: vi.fn(),
    fetchFile: vi.fn(),
    fetchTree: vi.fn(),
    fetchSubtree: vi.fn(),
    fetchWorktrees: vi.fn(),
    revealInFinder: vi.fn(),
  };

  mocks.useWorkspace.mockImplementation(() => workspaceValue);
  mocks.useFileManagement.mockReturnValue({
    createFile: vi.fn(),
    createDir: vi.fn(),
    deleteItem: vi.fn(),
    renameItem: vi.fn(),
    uploadFile: vi.fn(),
  });
  mocks.useChatStore.mockImplementation((sel: (s: Record<string, unknown>) => unknown) => sel(store));
  mocks.usePersistedState.mockImplementation((_key: string, init: unknown) => [init, vi.fn()]);

  return { store, workspaceValue };
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

  it('switches back to Files view when a workspace open file arrives after browser auto-open', async () => {
    const { store, workspaceValue } = setupWithMutableStore({
      pendingPreviewAutoOpen: { port: 5173, path: '/' },
    });
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');

    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    expect(container.querySelector('[data-testid="browser-panel"]')).not.toBeNull();

    store.workspaceOpenFilePath = 'packages/web/src/App.tsx';
    store.workspaceOpenTabs = ['packages/web/src/App.tsx'];
    workspaceValue.file = {
      path: 'packages/web/src/App.tsx',
      content: 'export function App() {}',
      size: 24,
      modified: new Date().toISOString(),
    };

    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    expect(container.querySelector('[data-testid="browser-panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="workspace-tree"]')).not.toBeNull();
  });

  it('keeps preview auto-open on mount when a selected file already exists', async () => {
    const { workspaceValue } = setupWithMutableStore({
      workspaceOpenFilePath: 'packages/web/src/App.tsx',
      workspaceOpenTabs: ['packages/web/src/App.tsx'],
      pendingPreviewAutoOpen: { port: 5173, path: '/' },
    });
    workspaceValue.file = {
      path: 'packages/web/src/App.tsx',
      content: 'export function App() {}',
      size: 24,
      modified: new Date().toISOString(),
    };
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');

    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    expect(container.querySelector('[data-testid="browser-panel"]')).not.toBeNull();
  });

  it('switches to Files view when the selected file is reopened after preview auto-open', async () => {
    const { store, workspaceValue } = setupWithMutableStore({
      workspaceOpenFilePath: 'packages/web/src/App.tsx',
      workspaceOpenTabs: ['packages/web/src/App.tsx'],
      pendingPreviewAutoOpen: { port: 5173, path: '/' },
      _workspaceFileSetAt: { ts: 0, threadId: 'thread-f223' },
    });
    workspaceValue.file = {
      path: 'packages/web/src/App.tsx',
      content: 'export function App() {}',
      size: 24,
      modified: new Date().toISOString(),
    };
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');

    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    expect(container.querySelector('[data-testid="browser-panel"]')).not.toBeNull();

    store.workspaceOpenFileLine = 42;
    store._workspaceFileSetAt = { ts: 1000, threadId: 'thread-f223' };

    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    expect(container.querySelector('[data-testid="browser-panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="workspace-tree"]')).not.toBeNull();
  });
});
