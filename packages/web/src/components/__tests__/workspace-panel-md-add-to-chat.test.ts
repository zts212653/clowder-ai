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

/* Mock heavy child components */
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) =>
    React.createElement('div', { 'data-testid': 'markdown-content' }, content),
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
vi.mock('@/components/workspace/WorkspaceTree', () => ({ WorkspaceTree: () => null }));

/* ---- Helpers ---- */
function makeFile(overrides: Record<string, unknown> = {}) {
  return {
    path: 'docs/test.md',
    content: '# Test\nSome markdown content here.',
    sha256: 'md5abc',
    size: 40,
    mime: 'text/markdown',
    truncated: false,
    binary: false,
    ...overrides,
  };
}

let setPendingChatInsert: ReturnType<typeof vi.fn>;

function setupMocks(fileOverrides: Record<string, unknown> = {}) {
  const file = makeFile(fileOverrides);
  setPendingChatInsert = vi.fn();

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
  mocks.useChatStore.mockImplementation((sel: (s: Record<string, unknown>) => unknown) => {
    const store: Record<string, unknown> = {
      workspaceWorktreeId: 'main',
      workspaceOpenFilePath: file.path,
      workspaceOpenFileLine: null,
      workspaceOpenTabs: [file.path],
      currentProjectPath: '/tmp/repo',
      currentThreadId: 'thread-1',
      setWorkspaceWorktreeId: vi.fn(),
      setWorkspaceOpenFilePath: vi.fn(),
      setWorkspaceOpenTabs: vi.fn(),
      workspaceExpanded: true,
      setWorkspaceExpanded: vi.fn(),
      currentWorktree: { id: 'main', branch: 'main', root: '/tmp/repo' },
      setPendingChatInsert,
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
  return file;
}

/**
 * Simulate a text selection within a specific container element.
 * Uses a mock Selection object since jsdom's Selection API is limited.
 */
function simulateSelection(anchorNode: Node | null, focusNode: Node | null, text: string) {
  const mockSelection = {
    isCollapsed: !text,
    anchorNode,
    focusNode,
    toString: () => text,
    rangeCount: text ? 1 : 0,
  };
  vi.spyOn(window, 'getSelection').mockReturnValue(mockSelection as unknown as Selection);
  document.dispatchEvent(new Event('selectionchange'));
}

function clearSelection() {
  const mockSelection = {
    isCollapsed: true,
    anchorNode: null,
    focusNode: null,
    toString: () => '',
    rangeCount: 0,
  };
  vi.spyOn(window, 'getSelection').mockReturnValue(mockSelection as unknown as Selection);
  document.dispatchEvent(new Event('selectionchange'));
}

/* ---- Tests ---- */
describe('WorkspacePanel Markdown Add to Chat', () => {
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

  it('shows Add to Chat button when text is selected inside rendered markdown', async () => {
    setupMocks();
    await renderPanel();

    const mdContent = container.querySelector('[data-testid="markdown-content"]');
    expect(mdContent).not.toBeNull();

    // Simulate selection within the markdown container
    await act(async () => {
      simulateSelection(mdContent, mdContent, 'Some markdown');
    });

    const btn = container.querySelector('button[title="引用到聊天"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toContain('Add to chat');
  });

  it('hides Add to Chat button when selection spans outside markdown container (P2 regression)', async () => {
    setupMocks();
    await renderPanel();

    const mdContent = container.querySelector('[data-testid="markdown-content"]');
    // focusNode is outside the markdown container (e.g. in the toolbar)
    const outsideNode = container.querySelector('button') ?? document.body;

    await act(async () => {
      simulateSelection(mdContent, outsideNode, 'cross boundary text');
    });

    const btn = container.querySelector('button[title="引用到聊天"]');
    expect(btn).toBeNull();
  });

  it('Add to Chat inserts correctly formatted reference', async () => {
    setupMocks();
    await renderPanel();

    const mdContent = container.querySelector('[data-testid="markdown-content"]');
    await act(async () => {
      simulateSelection(mdContent, mdContent, 'selected text');
    });

    const btn = container.querySelector('button[title="引用到聊天"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();

    await act(async () => {
      btn.click();
    });

    expect(setPendingChatInsert).toHaveBeenCalledWith({
      threadId: 'thread-1',
      text: '`docs/test.md` (🌿 main)\n```markdown\nselected text\n```',
    });
  });

  it('Add to Chat button reappears after Rendered→Edit→Rendered toggle (P1 regression)', async () => {
    setupMocks();

    // Mock edit-session API so handleToggleEdit succeeds
    let storedToken: string | null = null;
    let storedExpiry: number | null = null;
    const setEditTokenFn = vi.fn((token: string, expiresIn: number) => {
      storedToken = token;
      storedExpiry = Date.now() + expiresIn;
    });
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'tok-123', expiresIn: 60_000 }),
    });
    // Override useChatStore to use mutable token state + real setEditToken
    mocks.useChatStore.mockImplementation((sel: (s: Record<string, unknown>) => unknown) => {
      const store: Record<string, unknown> = {
        workspaceWorktreeId: 'main',
        workspaceOpenFilePath: 'docs/test.md',
        workspaceOpenFileLine: null,
        workspaceOpenTabs: ['docs/test.md'],
        currentProjectPath: '/tmp/repo',
        currentThreadId: 'thread-1',
        setWorkspaceWorktreeId: vi.fn(),
        setWorkspaceOpenFilePath: vi.fn(),
        setWorkspaceOpenTabs: vi.fn(),
        workspaceExpanded: true,
        setWorkspaceExpanded: vi.fn(),
        currentWorktree: { id: 'main', branch: 'main', root: '/tmp/repo' },
        setPendingChatInsert,
        setRightPanelMode: vi.fn(),
        workspaceEditToken: storedToken,
        workspaceEditTokenExpiry: storedExpiry,
        setWorkspaceEditToken: setEditTokenFn,
        pendingPreviewAutoOpen: null,
        clearPendingPreviewAutoOpen: vi.fn(),
        restoreWorkspaceTabs: vi.fn(),
        _workspaceFileSetAt: { ts: 0, threadId: null },
      };
      return sel(store);
    });

    await renderPanel();

    // Step 1: Verify markdown rendered mode — MarkdownContent is mounted
    let mdContent = container.querySelector('[data-testid="markdown-content"]');
    expect(mdContent).not.toBeNull();

    await act(async () => {
      simulateSelection(mdContent, mdContent, 'before edit');
    });
    let addBtn = container.querySelector('button[title="引用到聊天"]');
    expect(addBtn).not.toBeNull();

    // Step 2: Click "编辑" button → enters editMode (unmounts MarkdownContent, mounts CodeViewer)
    const editBtn = container.querySelector('button[title="编辑文件"]') as HTMLButtonElement;
    expect(editBtn).not.toBeNull();
    await act(async () => {
      clearSelection();
      editBtn.click();
    });

    // Verify: MarkdownContent gone, CodeViewer mounted
    expect(container.querySelector('[data-testid="markdown-content"]')).toBeNull();
    expect(container.querySelector('[data-testid="code-viewer"]')).not.toBeNull();

    // Step 3: Click "退出编辑" → back to rendered mode (re-mounts MarkdownContent with NEW DOM)
    // handleToggleEdit already called setEditToken (updating closured vars) + setEditMode(true)
    // (re-render picks up the updated token), so no manual token injection needed.
    // If setEditToken call were removed from WorkspacePanel, this would fail because
    // isTokenValid would be false and the button title would remain "编辑文件".
    const exitBtn = container.querySelector('button[title="退出编辑"]') as HTMLButtonElement;
    expect(exitBtn).not.toBeNull();
    await act(async () => {
      exitBtn.click();
    });

    // Step 4: Verify NEW MarkdownContent container is mounted
    mdContent = container.querySelector('[data-testid="markdown-content"]');
    expect(mdContent).not.toBeNull();

    // Step 5: Selection on the NEW container should still trigger Add to Chat
    await act(async () => {
      simulateSelection(mdContent, mdContent, 'after toggle');
    });
    addBtn = container.querySelector('button[title="引用到聊天"]');
    expect(addBtn).not.toBeNull();
  });
});
