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
vi.mock('@/components/eval-workspace/EvalWorkspacePanel', () => ({
  EvalWorkspacePanel: () => React.createElement('div', { 'data-testid': 'eval-workspace-panel' }, '评估'),
}));

function setupMocks() {
  mocks.useWorkspace.mockReturnValue({
    worktrees: [{ id: 'cat-cafe-runtime', branch: 'runtime/main-sync', root: '/tmp/repo' }],
    worktreeId: 'cat-cafe-runtime',
    tree: [],
    file: null,
    searchResults: [],
    loading: false,
    searchLoading: false,
    error: null,
    search: vi.fn().mockResolvedValue(undefined),
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
      workspaceMode: 'eval',
      setWorkspaceMode: vi.fn(),
    };
    return sel(store);
  });
  mocks.usePersistedState.mockImplementation((_key: string, init: unknown) => [init, vi.fn()]);
  mocks.apiFetch.mockResolvedValue({ json: async () => ({ preferredWorkspaceMode: 'eval' }) });
}

describe('WorkspacePanel eval mode', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    setupMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('routes workspaceMode eval to EvalWorkspacePanel', async () => {
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');

    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    expect(container.querySelector('[data-testid="eval-workspace-panel"]')).not.toBeNull();
  });
});
