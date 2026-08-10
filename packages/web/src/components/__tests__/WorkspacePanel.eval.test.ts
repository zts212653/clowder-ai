import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useWorkspace: vi.fn(),
  useFileManagement: vi.fn(),
  useChatStore: vi.fn(),
  apiFetch: vi.fn(),
  usePersistedState: vi.fn(),
  enablePresentationLock: vi.fn(),
  disablePresentationLock: vi.fn(),
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
vi.mock('@/components/workspace/ChangesPanel', () => ({
  ChangesPanel: () => React.createElement('div', { 'data-testid': 'changes-panel' }),
}));
vi.mock('@/components/workspace/GitPanel', () => ({
  GitPanel: () => React.createElement('div', { 'data-testid': 'git-panel' }),
}));
vi.mock('@/components/workspace/TerminalTab', () => ({
  TerminalTab: () => React.createElement('div', { 'data-testid': 'terminal-tab' }),
}));
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
vi.mock('@/components/workspace/WorkspaceTree', () => ({
  WorkspaceTree: () => React.createElement('div', { 'data-testid': 'workspace-tree' }),
}));
vi.mock('@/components/eval-workspace/EvalWorkspacePanel', () => ({
  EvalWorkspacePanel: () => React.createElement('div', { 'data-testid': 'eval-workspace-panel' }, '评估'),
}));

function setupMocks({
  workspaceMode = 'eval',
  workspaceSurface = 'home',
  file = null,
}: {
  workspaceMode?: string;
  workspaceSurface?: string;
  file?: Record<string, unknown> | null;
} = {}) {
  mocks.useWorkspace.mockReturnValue({
    worktrees: [{ id: 'cat-cafe-runtime', branch: 'runtime/main-sync', root: '/tmp/repo' }],
    worktreeId: 'cat-cafe-runtime',
    tree: [],
    file,
    searchResults: [],
    loading: false,
    worktreesLoading: false,
    worktreesError: null,
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
      workspaceOpenFilePath: file ? 'docs/guide.md' : null,
      workspaceOpenTabs: file ? ['docs/guide.md'] : [],
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
      workspaceMode,
      setWorkspaceMode: vi.fn(),
      workspaceSurface,
      setWorkspaceSurface: vi.fn(),
      workspacePreview: { port: undefined, path: '/' },
      setWorkspacePreview: vi.fn(),
      presentationLock: false,
      enablePresentationLock: mocks.enablePresentationLock,
      disablePresentationLock: mocks.disablePresentationLock,
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
    mocks.enablePresentationLock.mockReset();
    mocks.disablePresentationLock.mockReset();
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

  it('keeps the file tree visible while a file detail is open', async () => {
    setupMocks({
      workspaceMode: 'dev',
      workspaceSurface: 'files',
      file: {
        path: 'docs/guide.md',
        content: '# Guide',
        sha256: 'abc123',
        size: 7,
        mime: 'text/markdown',
        truncated: false,
        binary: false,
      },
    });
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');

    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    expect(container.querySelector('[data-testid="workspace-tree"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="markdown"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="关闭标签页"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="关闭 guide.md"]')?.textContent?.trim()).toBe('×');
    expect(container.querySelector('aside')?.className).not.toContain('hidden lg:flex');
  });

  it('keeps every file action reachable through a horizontally scrollable toolbar', async () => {
    setupMocks({
      workspaceMode: 'dev',
      workspaceSurface: 'files',
      file: {
        path: 'docs/guide.md',
        content: '# Guide',
        sha256: 'abc123',
        size: 7,
        mime: 'text/markdown',
        truncated: false,
        binary: false,
      },
    });
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');

    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    const toolbar = container.querySelector<HTMLElement>('[data-testid="workspace-file-toolbar"]');
    const content = container.querySelector<HTMLElement>('[data-testid="workspace-file-toolbar-content"]');
    const viewer = container.querySelector<HTMLElement>('[data-testid="workspace-file-viewer"]');
    expect(viewer).not.toBeNull();
    expect(viewer?.className).toContain('min-w-0');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.className).toContain('overflow-x-auto');
    expect(toolbar?.getAttribute('role')).toBe('toolbar');
    expect(content?.className).toContain('w-max');
    expect(content?.className).toContain('min-w-full');
    expect(container.querySelector('[aria-label="关闭标签页"]')).not.toBeNull();
  });

  it('keeps Presentation Lock reachable from the Workspace Launcher', async () => {
    setupMocks({ workspaceMode: 'dev', workspaceSurface: 'home' });
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');

    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    const lock = container.querySelector<HTMLButtonElement>('[aria-label="锁定当前文件视图"]');
    expect(lock).not.toBeNull();

    await act(async () => {
      lock?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mocks.enablePresentationLock).toHaveBeenCalledOnce();
  });

  it('renders the large-file truncation notice as readable text', async () => {
    setupMocks({
      workspaceMode: 'dev',
      workspaceSurface: 'files',
      file: {
        path: 'docs/guide.md',
        content: '# Guide',
        sha256: 'abc123',
        size: 1_048_577,
        mime: 'text/markdown',
        truncated: true,
        binary: false,
      },
    });
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');

    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    expect(container.textContent).toContain('文件已截断 (超过 1MB)');
    expect(container.textContent).not.toContain('\\u6587');
  });

  it.each([
    ['changes', 'changes-panel'],
    ['git', 'git-panel'],
    ['terminal', 'terminal-tab'],
    ['browser', 'browser-panel'],
  ])('keeps the %s Dev surface reachable', async (workspaceSurface, testId) => {
    setupMocks({ workspaceMode: 'dev', workspaceSurface });
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');

    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    expect(container.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
  });
});
