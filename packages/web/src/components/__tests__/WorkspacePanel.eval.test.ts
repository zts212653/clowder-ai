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
  setWorkspaceMode: vi.fn(),
  restoreWorkspaceMode: vi.fn(),
  setWorkspaceSurface: vi.fn(),
  restoreWorkspaceSurface: vi.fn(),
}));

vi.mock('@/hooks/useWorkspace', () => ({
  useWorkspace: (...args: unknown[]) => mocks.useWorkspace(...args),
}));
vi.mock('@/hooks/useFileManagement', () => ({
  useFileManagement: (...args: unknown[]) => mocks.useFileManagement(...args),
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign((sel: (s: Record<string, unknown>) => unknown) => mocks.useChatStore(sel), {
    getState: () => mocks.useChatStore((state: Record<string, unknown>) => state),
  }),
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
  currentThreadId = 'thread-1',
  preferredWorkspaceMode = 'eval',
  rightPanelMode = 'workspace',
  rightPanelOpen = true,
}: {
  workspaceMode?: string;
  workspaceSurface?: string;
  file?: Record<string, unknown> | null;
  currentThreadId?: string;
  preferredWorkspaceMode?: string;
  rightPanelMode?: string;
  rightPanelOpen?: boolean;
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
      workspaceOpenFilePath: typeof file?.path === 'string' ? file.path : null,
      workspaceOpenTabs: typeof file?.path === 'string' ? [file.path] : [],
      currentProjectPath: '/tmp/repo',
      currentThreadId,
      setWorkspaceWorktreeId: vi.fn(),
      setWorkspaceOpenFilePath: vi.fn(),
      setWorkspaceOpenTabs: vi.fn(),
      setWorkspaceOpenFile: vi.fn(),
      workspaceExpanded: true,
      setWorkspaceExpanded: vi.fn(),
      currentWorktree: { id: 'cat-cafe-runtime', branch: 'runtime/main-sync', root: '/tmp/repo' },
      setPendingChatInsert: vi.fn(),
      setRightPanelMode: vi.fn(),
      rightPanelMode,
      rightPanelOpen,
      workspaceEditToken: null,
      workspaceEditTokenExpiry: null,
      setWorkspaceEditToken: vi.fn(),
      pendingPreviewAutoOpen: null,
      clearPendingPreviewAutoOpen: vi.fn(),
      restoreWorkspaceTabs: vi.fn(),
      _workspaceFileSetAt: { ts: 0, threadId: null },
      workspaceMode,
      setWorkspaceMode: mocks.setWorkspaceMode,
      restoreWorkspaceMode: mocks.restoreWorkspaceMode,
      workspaceSurface,
      setWorkspaceSurface: mocks.setWorkspaceSurface,
      restoreWorkspaceSurface: mocks.restoreWorkspaceSurface,
      workspacePreview: { port: undefined, path: '/' },
      setWorkspacePreview: vi.fn(),
      presentationLock: false,
      enablePresentationLock: mocks.enablePresentationLock,
      disablePresentationLock: mocks.disablePresentationLock,
    };
    return sel(store);
  });
  mocks.usePersistedState.mockImplementation((_key: string, init: unknown) => [init, vi.fn()]);
  mocks.apiFetch.mockResolvedValue({ json: async () => ({ preferredWorkspaceMode }) });
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
    mocks.setWorkspaceMode.mockReset();
    mocks.restoreWorkspaceMode.mockReset();
    mocks.setWorkspaceSurface.mockReset();
    mocks.restoreWorkspaceSurface.mockReset();
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

  it('restores a thread preferred mode without treating it as a request to open Workspace', async () => {
    setupMocks({ workspaceMode: 'dev', preferredWorkspaceMode: 'tasks' });
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');

    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    expect(mocks.restoreWorkspaceMode).toHaveBeenCalledWith('tasks');
    expect(mocks.setWorkspaceMode).not.toHaveBeenCalled();
  });

  it('does not let a delayed preferred mode cover an explicit Browser Preview', async () => {
    setupMocks({
      workspaceMode: 'dev',
      workspaceSurface: 'browser',
      preferredWorkspaceMode: 'approval',
      rightPanelMode: 'workspace',
      rightPanelOpen: true,
    });
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');

    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    expect(container.querySelector('[data-testid="browser-panel"]')).not.toBeNull();
    expect(mocks.restoreWorkspaceMode).not.toHaveBeenCalledWith('approval');
  });

  it('restores the Files surface on a thread switch without treating it as a request to open Workspace', async () => {
    const threadAFile = {
      path: 'docs/a.md',
      content: '# A',
      sha256: 'aaa',
      size: 3,
      mime: 'text/markdown',
      truncated: false,
      binary: false,
    };
    const threadBFile = { ...threadAFile, path: 'docs/b.md', content: '# B', sha256: 'bbb' };
    setupMocks({
      workspaceMode: 'dev',
      workspaceSurface: 'files',
      file: threadAFile,
      currentThreadId: 'thread-a',
      preferredWorkspaceMode: 'dev',
    });
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');

    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });
    mocks.setWorkspaceSurface.mockClear();
    mocks.restoreWorkspaceSurface.mockClear();

    setupMocks({
      workspaceMode: 'dev',
      workspaceSurface: 'files',
      file: threadBFile,
      currentThreadId: 'thread-b',
      preferredWorkspaceMode: 'dev',
    });
    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    expect(mocks.restoreWorkspaceSurface).toHaveBeenCalledWith('files');
    expect(mocks.setWorkspaceSurface).not.toHaveBeenCalled();
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
