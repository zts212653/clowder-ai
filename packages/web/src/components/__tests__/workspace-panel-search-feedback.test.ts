import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('@/components/workspace/WorkspaceTree', () => ({
  WorkspaceTree: () => React.createElement('div', { 'data-testid': 'workspace-tree' }),
}));

function setupMocks() {
  const search = vi.fn().mockResolvedValue(undefined);

  mocks.useWorkspace.mockReturnValue({
    worktrees: [{ id: 'cat-cafe-runtime', branch: 'runtime/main-sync', root: '/tmp/repo' }],
    worktreeId: 'cat-cafe-runtime',
    tree: [],
    file: null,
    searchResults: [],
    loading: false,
    searchLoading: false,
    error: null,
    search,
    setSearchResults: vi.fn(),
    fetchFile: vi.fn(),
    fetchTree: vi.fn(),
    fetchSubtree: vi.fn(),
    fetchWorktrees: vi.fn(),
    revealInFinder: vi.fn(),
  });
  mocks.useFileManagement.mockReturnValue({
    createFile: vi.fn(),
    createDir: vi.fn(),
    deleteItem: vi.fn(),
    renameItem: vi.fn(),
    uploadFile: vi.fn(),
  });
  mocks.useChatStore.mockImplementation((sel: (s: Record<string, unknown>) => unknown) => {
    const store: Record<string, unknown> = {
      workspaceWorktreeId: 'cat-cafe-runtime',
      workspaceOpenFilePath: null,
      workspaceOpenTabs: [],
      currentProjectPath: '/tmp/repo',
      currentThreadId: 'thread-1',
      setWorkspaceWorktreeId: vi.fn(),
      setWorkspaceOpenFilePath: vi.fn(),
      setWorkspaceOpenTabs: vi.fn(),
      setWorkspaceOpenFile: vi.fn(),
      workspaceExpanded: true,
      setWorkspaceExpanded: vi.fn(),
      currentWorktree: { id: 'cat-cafe-runtime', branch: 'runtime/main-sync', root: '/tmp/repo' },
      setPendingChatInsert: vi.fn(),
      setRightPanelMode: vi.fn(),
      workspaceEditToken: null,
      workspaceEditTokenExpiry: null,
      setWorkspaceEditToken: vi.fn(),
      pendingPreviewAutoOpen: null,
      clearPendingPreviewAutoOpen: vi.fn(),
      restoreWorkspaceTabs: vi.fn(),
      _workspaceFileSetAt: { ts: 0, threadId: null },
    };
    return sel(store);
  });
  mocks.usePersistedState.mockImplementation((_key: string, init: unknown) => [init, vi.fn()]);
  return { search };
}

describe('WorkspacePanel search feedback', () => {
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

  it('shows a no-results message with the active worktree after a submitted search', async () => {
    const { search } = setupMocks();
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');

    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input).not.toBeNull();

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(input, 'README-A2A-SEARCH');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const form = container.querySelector('form');
    expect(form).not.toBeNull();

    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(search).toHaveBeenCalledWith('README-A2A-SEARCH', 'all');
    expect(container.textContent).toContain('未在 runtime/main-sync 中找到');
    expect(container.textContent).toContain('README-A2A-SEARCH');
  });

  it('shows "搜索中..." spinner when searchLoading is true', async () => {
    setupMocks();
    // Override: searchLoading=true simulates an in-flight search request
    mocks.useWorkspace.mockReturnValue({
      ...mocks.useWorkspace(),
      searchLoading: true,
    });
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');

    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    expect(container.textContent).toContain('搜索中...');
  });

  it('does NOT show "搜索中..." when tree/file loading is active after a prior search', async () => {
    const { search } = setupMocks();
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');

    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    // Submit a search to set internal didSearch=true
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(input, '猫');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = container.querySelector('form');
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(search).toHaveBeenCalled();

    // Now simulate tree/file loading (loading=true) but search is NOT loading
    mocks.useWorkspace.mockReturnValue({
      ...mocks.useWorkspace(),
      loading: true,
      searchLoading: false,
    });
    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    // Should NOT show search spinner during non-search loading
    expect(container.textContent).not.toContain('搜索中...');
  });
});
