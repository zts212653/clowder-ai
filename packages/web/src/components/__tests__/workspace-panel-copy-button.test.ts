import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/* ---- Hoisted mocks (must be before vi.mock calls) ---- */
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

/* Mock heavy child components to keep tests fast */
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: () => React.createElement('div', { 'data-testid': 'markdown' }),
}));
vi.mock('@/components/workspace/ChangesPanel', () => ({
  ChangesPanel: () => null,
}));
vi.mock('@/components/workspace/GitPanel', () => ({
  GitPanel: () => null,
}));
vi.mock('@/components/workspace/TerminalTab', () => ({
  TerminalTab: () => null,
}));
vi.mock('@/components/workspace/JsxPreview', () => ({
  JsxPreview: () => null,
}));
vi.mock('@/components/workspace/LinkedRootsManager', () => ({
  LinkedRootsManager: () => null,
  LinkedRootRemoveButton: () => null,
}));
vi.mock('@/components/workspace/CodeViewer', () => ({
  CodeViewer: () => React.createElement('div', { 'data-testid': 'code-viewer' }),
}));
vi.mock('@/components/workspace/FileIcons', () => ({
  FileIcon: () => null,
}));
vi.mock('@/components/workspace/ResizeHandle', () => ({
  ResizeHandle: () => null,
}));
vi.mock('@/components/workspace/WorkspaceTree', () => ({
  WorkspaceTree: () => null,
}));

/* ---- Helpers ---- */
function makeFile(overrides: Record<string, unknown> = {}) {
  return {
    path: 'README.md',
    content: '# Hello World\nThis is a test file.',
    sha256: 'abc123',
    size: 42,
    mime: 'text/markdown',
    truncated: false,
    binary: false,
    ...overrides,
  };
}

function setupMocks(fileOverrides: Record<string, unknown> = {}) {
  const file = makeFile(fileOverrides);
  mocks.useWorkspace.mockReturnValue({
    worktrees: [{ id: 'main', branch: 'main', root: '/tmp/repo', isBare: false, isMain: true }],
    worktreeId: 'main',
    tree: [],
    file,
    searchResults: [],
    loading: false,
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
  /* useChatStore: return sensible defaults for each selector */
  mocks.useChatStore.mockImplementation((sel: (s: Record<string, unknown>) => unknown) => {
    const store: Record<string, unknown> = {
      workspaceWorktreeId: 'main',
      workspaceOpenFilePath: file.path,
      workspaceOpenTabs: [file.path],
      currentProjectPath: '/tmp/repo',
      setWorkspaceWorktreeId: vi.fn(),
      setWorkspaceOpenFilePath: vi.fn(),
      setWorkspaceOpenTabs: vi.fn(),
      workspaceExpanded: true,
      setWorkspaceExpanded: vi.fn(),
      currentWorktree: { id: 'main', branch: 'main', root: '/tmp/repo' },
      _workspaceFileSetAt: { ts: 0, threadId: null },
    };
    return sel(store);
  });
  mocks.usePersistedState.mockImplementation((_key: string, init: unknown) => [init, vi.fn()]);
  return file;
}

/* ---- Tests ---- */
describe('WorkspacePanel Copy button', () => {
  let container: HTMLDivElement;
  let root: Root;
  let clipboardWriteText: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: clipboardWriteText, readText: vi.fn() },
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

  async function renderPanel() {
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');
    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });
  }

  it('renders Copy button and copies file content on click', async () => {
    setupMocks({ content: '# Hello\nWorld' });
    await renderPanel();

    const btn = container.querySelector('button[title="复制文件全文"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('Copy');

    await act(async () => {
      btn.click();
    });
    expect(clipboardWriteText).toHaveBeenCalledWith('# Hello\nWorld');
  });

  it('shows "Copy…" with truncation warning when file is truncated', async () => {
    setupMocks({ truncated: true, content: 'partial content...' });
    await renderPanel();

    const btn = container.querySelector(
      'button[title="复制已加载内容（文件已截断，非完整全文）"]',
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('Copy…');
  });

  it('renders Copy button for empty file (content is "")', async () => {
    setupMocks({ content: '', size: 0 });
    await renderPanel();

    const btn = container.querySelector('button[title="复制文件全文"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('Copy');

    await act(async () => {
      btn.click();
    });
    expect(clipboardWriteText).toHaveBeenCalledWith('');
  });
});
