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

let storeState: Record<string, unknown>;

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
  TerminalTab: () => React.createElement('div', { 'data-testid': 'terminal-panel' }),
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
vi.mock('@/components/workspace/KnowledgeFeed', () => ({
  KnowledgeFeed: () => React.createElement('div', { 'data-testid': 'knowledge-feed' }),
}));
vi.mock('@/components/workspace/SchedulePanel', () => ({
  SchedulePanel: () => React.createElement('div', { 'data-testid': 'schedule-panel' }),
}));
vi.mock('@/components/workspace/BrowserPanel', () => ({
  BrowserPanel: ({
    initialPort,
    initialPath,
    onNavigate,
    previewOnly,
  }: {
    initialPort?: number;
    initialPath?: string;
    onNavigate?: (port: number, path: string) => void;
    previewOnly?: boolean;
  }) =>
    React.createElement(
      'div',
      {
        'data-testid': 'browser-panel',
        'data-preview-only': previewOnly ? '1' : '0',
        'data-initial-port': initialPort == null ? '' : String(initialPort),
        'data-initial-path': initialPath ?? '',
      },
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'browser-panel-mock-navigate',
          onClick: () => onNavigate?.(4173, '/deep-link'),
        },
        'mock navigate',
      ),
    ),
}));

function setupMocks(options?: { file?: Record<string, unknown> | null }) {
  const file =
    options?.file === null
      ? null
      : {
          path: 'docs/guide.md',
          content: '# Preview\nhello',
          sha256: 'sha-file',
          size: 12,
          mime: 'text/markdown',
          truncated: false,
          binary: false,
          ...(options?.file ?? {}),
        };
  mocks.useWorkspace.mockReturnValue({
    worktrees: [{ id: 'wt-main', branch: 'main', head: 'abc123', root: '/tmp/repo' }],
    worktreeId: 'wt-main',
    tree: [],
    file,
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
  });
  mocks.useFileManagement.mockReturnValue({
    createFile: vi.fn(),
    createDir: vi.fn(),
    deleteItem: vi.fn(),
    renameItem: vi.fn(),
    uploadFile: vi.fn(),
  });
  storeState = {
    setWorkspaceWorktreeId: vi.fn(),
    setWorkspaceOpenFile: vi.fn(),
    workspaceOpenTabs: file ? [String(file.path)] : [],
    closeWorkspaceTab: vi.fn(),
    workspaceOpenFilePath: file ? String(file.path) : null,
    workspaceOpenFileLine: null,
    setRightPanelMode: vi.fn(),
    setPendingChatInsert: vi.fn(),
    currentThreadId: 'thread-1',
    workspaceEditToken: null,
    workspaceEditTokenExpiry: null,
    setWorkspaceEditToken: vi.fn(),
    pendingPreviewAutoOpen: null,
    consumePreviewAutoOpen: vi.fn(),
    workspaceRevealPath: null,
    setWorkspaceRevealPath: vi.fn(),
    workspaceMode: 'dev',
    setWorkspaceMode: vi.fn(),
  };
  mocks.useChatStore.mockImplementation((sel: (s: Record<string, unknown>) => unknown) => sel(storeState));
  mocks.usePersistedState.mockImplementation((_k: string, init: unknown) => [init, vi.fn()]);
}

describe('WorkspacePanel preview-only mode', () => {
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
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('can enter/exit preview-only mode in browser tab and hides workspace chrome while active', async () => {
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');
    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    expect(container.textContent).toContain('Workspace');

    const browserTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('🌐'));
    expect(browserTab).toBeTruthy();
    await act(async () => {
      browserTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const enterPreviewOnly = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('专注预览'),
    );
    expect(enterPreviewOnly).toBeTruthy();
    await act(async () => {
      enterPreviewOnly?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).not.toContain('Workspace');
    const browserPanel = container.querySelector('[data-testid="browser-panel"]');
    expect(browserPanel?.getAttribute('data-preview-only')).toBe('1');

    const exitPreviewOnly = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('退出专注'),
    );
    expect(exitPreviewOnly).toBeTruthy();
    await act(async () => {
      exitPreviewOnly?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Workspace');
    const browserPanelAfterExit = container.querySelector('[data-testid="browser-panel"]');
    expect(browserPanelAfterExit?.getAttribute('data-preview-only')).toBe('0');
  });

  it('auto-exits preview-only mode when workspace mode changes externally', async () => {
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');
    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    const browserTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('🌐'));
    await act(async () => {
      browserTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const enterPreviewOnly = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('专注预览'),
    );
    await act(async () => {
      enterPreviewOnly?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="browser-panel"]')?.getAttribute('data-preview-only')).toBe('1');

    storeState.workspaceMode = 'knowledge';
    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    expect(container.textContent).toContain('Workspace');
    expect(container.querySelector('[data-testid="knowledge-feed"]')).not.toBeNull();
    expect(container.querySelector('button')?.textContent ?? '').not.toContain('退出专注');
  });

  it('keeps latest browser location when entering preview-only mode', async () => {
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');
    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    const browserTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('🌐'));
    await act(async () => {
      browserTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const mockNavigate = container.querySelector('[data-testid="browser-panel-mock-navigate"]');
    expect(mockNavigate).toBeTruthy();
    await act(async () => {
      mockNavigate?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const enterPreviewOnly = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('专注预览'),
    );
    await act(async () => {
      enterPreviewOnly?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const browserPanel = container.querySelector('[data-testid="browser-panel"]');
    expect(browserPanel?.getAttribute('data-preview-only')).toBe('1');
    expect(browserPanel?.getAttribute('data-initial-port')).toBe('4173');
    expect(browserPanel?.getAttribute('data-initial-path')).toBe('/deep-link');
  });

  it('can enter file focus mode from files view and exit back to workspace chrome', async () => {
    setupMocks();
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');
    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    expect(container.textContent).toContain('Workspace');
    expect(container.querySelector('[data-testid="markdown"]')).not.toBeNull();

    const enterFocus = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('专注预览'),
    );
    expect(enterFocus).toBeTruthy();
    await act(async () => {
      enterFocus?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).not.toContain('Workspace');
    const shell = container.querySelector('[data-testid="workspace-focus-shell"]');
    const viewport = container.querySelector('[data-testid="workspace-focus-shell-viewport"]');
    expect(shell).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(container.querySelector('[data-testid="markdown"]')).not.toBeNull();

    const exitFocus = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('退出专注'));
    expect(exitFocus).toBeTruthy();
    await act(async () => {
      exitFocus?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Workspace');
  });

  it('can enter focus mode for terminal tab using the shared focus shell', async () => {
    setupMocks({ file: null });
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');
    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });

    const terminalTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Term'));
    expect(terminalTab).toBeTruthy();
    await act(async () => {
      terminalTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const enterFocus = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('专注模式'),
    );
    expect(enterFocus).toBeTruthy();
    await act(async () => {
      enterFocus?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).not.toContain('Workspace');
    expect(container.querySelector('[data-testid="terminal-panel"]')).not.toBeNull();
  });
});
