'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFileEditing } from '@/hooks/useFileEditing';
import { useFileManagement } from '@/hooks/useFileManagement';
import { usePersistedState } from '@/hooks/usePersistedState';
import { useTreeNavigation } from '@/hooks/useTreeNavigation';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useWorkspaceSearch } from '@/hooks/useWorkspaceSearch';
import { useChatStore } from '@/stores/chatStore';
import { API_URL, apiFetch } from '@/utils/api-client';
import { CommunityPanel } from './CommunityPanel';
import { RecallFeed } from './memory/RecallFeed';
import { TaskBoardPanel } from './TaskBoardPanel';
import { useConfirm } from './useConfirm';
import { BrowserPanel } from './workspace/BrowserPanel';
import { ChangesPanel } from './workspace/ChangesPanel';
import { FileIcon } from './workspace/FileIcons';
import { FocusModeButton } from './workspace/FocusModeButton';
import { GitPanel } from './workspace/GitPanel';
import { LinkedRootRemoveButton, LinkedRootsManager } from './workspace/LinkedRootsManager';
import { ResizeHandle } from './workspace/ResizeHandle';
import { SchedulePanel } from './workspace/SchedulePanel';
import { TerminalTab } from './workspace/TerminalTab';
import { WorkspaceFileViewer } from './workspace/WorkspaceFileViewer';
import { WorkspaceFocusShell } from './workspace/WorkspaceFocusShell';
import { WorkspacePreviewOnly } from './workspace/WorkspacePreviewOnly';
import { WorkspaceTree } from './workspace/WorkspaceTree';

/* ── Search result item ──────────────────────── */
function SearchResultItem({
  path: filePath,
  line,
  content,
  query,
  onClick,
}: {
  path: string;
  line: number;
  content: string;
  query: string;
  onClick: () => void;
}) {
  const fileName = filePath.split('/').pop() ?? filePath;
  const dir = filePath.slice(0, filePath.length - fileName.length);

  const highlighted = useMemo(() => {
    if (!query || !content) return content;
    const idx = content.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return content;
    return (
      <>
        {content.slice(0, idx)}
        <mark className="bg-[var(--console-hover-bg)] text-cafe-secondary rounded px-0.5">
          {content.slice(idx, idx + query.length)}
        </mark>
        {content.slice(idx + query.length)}
      </>
    );
  }, [content, query]);

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left px-3 py-1.5 hover:bg-[var(--console-hover-bg)] transition-colors group"
    >
      <div className="flex items-center gap-1.5">
        <FileIcon name={fileName} />
        <span className="text-xs font-medium text-cafe-black truncate">{fileName}</span>
        {line > 0 && <span className="text-[10px] text-cafe-muted font-mono">:{line}</span>}
      </div>
      {dir && <div className="text-[10px] text-cafe-muted truncate ml-5">{dir}</div>}
      {content && <div className="text-[10px] text-cafe-secondary truncate font-mono ml-5 mt-0.5">{highlighted}</div>}
    </button>
  );
}

/* ── SVG micro-icons ─────────────────────────── */
const CloseIcon = () => (
  <svg
    width="10"
    height="10"
    viewBox="0 0 10 10"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    aria-hidden="true"
  >
    <path d="M1 1l8 8M9 1l-8 8" />
  </svg>
);

const SearchIcon = () => (
  <svg className="w-3.5 h-3.5 text-cafe-muted flex-shrink-0" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path
      fillRule="evenodd"
      d="M9.965 11.026a5 5 0 1 1 1.06-1.06l2.755 2.754a.75.75 0 1 1-1.06 1.06l-2.755-2.754ZM10.5 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z"
      clipRule="evenodd"
    />
  </svg>
);

const MenuIcon = () => (
  <svg className="w-4 h-4 text-cafe-accent flex-shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <path
      fillRule="evenodd"
      d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10zm0 5.25a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z"
      clipRule="evenodd"
    />
  </svg>
);

/* ── Main panel ──────────────────────────────── */
export function WorkspacePanel() {
  const confirm = useConfirm();
  const {
    worktrees,
    worktreeId,
    tree,
    file,
    searchResults,
    loading,
    searchLoading,
    error,
    search,
    setSearchResults,
    fetchFile,
    fetchTree,
    fetchSubtree,
    fetchWorktrees,
    revealInFinder,
    pendingExternalSha,
    setEditDirty,
    applyExternalChange,
    dismissExternalChange,
  } = useWorkspace();

  const setWorktreeId = useChatStore((s) => s.setWorkspaceWorktreeId);
  const setOpenFile = useChatStore((s) => s.setWorkspaceOpenFile);
  const openTabs = useChatStore((s) => s.workspaceOpenTabs);
  const closeTab = useChatStore((s) => s.closeWorkspaceTab);
  const openFilePath = useChatStore((s) => s.workspaceOpenFilePath);
  const scrollToLine = useChatStore((s) => s.workspaceOpenFileLine);
  const setRightPanelMode = useChatStore((s) => s.setRightPanelMode);
  const setPendingChatInsert = useChatStore((s) => s.setPendingChatInsert);
  const currentThreadId = useChatStore((s) => s.currentThreadId);

  const pendingPreviewAutoOpen = useChatStore((s) => s.pendingPreviewAutoOpen);
  const consumePreviewAutoOpen = useChatStore((s) => s.consumePreviewAutoOpen);
  const { createFile, createDir, deleteItem, renameItem, uploadFile } = useFileManagement();

  const { expandedPaths, toggleExpand, revealInTree } = useTreeNavigation({
    tree,
    currentThreadId,
    fetchSubtree,
  });

  const { editMode, setEditMode, saveError, canEdit, handleToggleEdit, handleSave } = useFileEditing({
    worktreeId,
    openFilePath,
    file,
    fetchFile,
  });

  const [viewMode, setViewMode] = useState<'files' | 'changes' | 'git' | 'terminal' | 'browser'>('files');
  // Phase H: Workspace mode switcher (dev tools vs knowledge feed)
  const workspaceMode = useChatStore((s) => s.workspaceMode);
  const setWorkspaceMode = useChatStore((s) => s.setWorkspaceMode);
  const [previewPort, setPreviewPort] = useState<number | undefined>();
  const [previewPath, setPreviewPath] = useState<string>('/');
  const [focusedPane, setFocusedPane] = useState<'browser' | 'changes' | 'file' | 'git' | 'terminal' | null>(null);

  // Keep parent state in sync with BrowserPanel navigation (focus mode state preservation)
  const handleBrowserNavigate = useCallback((port: number, path: string) => {
    setPreviewPort(port);
    setPreviewPath(path);
  }, []);

  // Auto-exit focus mode when context changes
  useEffect(() => {
    if (!focusedPane) return;
    if (workspaceMode !== 'dev') {
      setFocusedPane(null);
      return;
    }
    if (focusedPane === 'file' && (viewMode !== 'files' || !file)) {
      setFocusedPane(null);
      return;
    }
    if (focusedPane !== 'file' && viewMode !== focusedPane) setFocusedPane(null);
  }, [file, focusedPane, viewMode, workspaceMode]);

  const storeRevealPath = useChatStore((s) => s.workspaceRevealPath);
  useEffect(() => {
    if (storeRevealPath) setViewMode('files');
  }, [storeRevealPath]);

  // F120: Consume pending auto-open from always-mounted listener (ChatContainer)
  useEffect(() => {
    if (!pendingPreviewAutoOpen) return;
    const data = consumePreviewAutoOpen();
    if (data) {
      setPreviewPort(data.port);
      setPreviewPath(data.path);
      setViewMode('browser');
    }
  }, [pendingPreviewAutoOpen, consumePreviewAutoOpen]);
  const [portDiscoveryToast, setPortDiscoveryToast] = useState<{ port: number; framework?: string } | null>(null);

  const {
    searchQuery,
    setSearchQuery,
    searchMode,
    setSearchMode,
    didSearch,
    setDidSearch,
    searchIme,
    handleSearchSubmit,
    handleSearchResultClick,
  } = useWorkspaceSearch({
    search,
    setSearchResults,
    setOpenFile,
    revealInTree,
    onFileSelect: () => setEditMode(false),
  });

  const handleFileSelect = useCallback(
    (path: string) => {
      setOpenFile(path);
      setSearchResults([]);
      setDidSearch(false);
      setEditMode(false);
    },
    [setOpenFile, setSearchResults, setDidSearch, setEditMode],
  );

  // G7-2: Per-thread expandedPaths cache is now handled inside useTreeNavigation hook.

  // F168: Auto-switch workspace mode based on thread's preferredWorkspaceMode.
  // Also resets from 'community' when switching to a thread without a preference,
  // preventing mode leakage across threads.
  useEffect(() => {
    if (!currentThreadId) return;
    let cancelled = false;
    apiFetch(`/api/threads/${currentThreadId}`)
      ?.then((res) => res.json())
      .then((thread: { preferredWorkspaceMode?: string }) => {
        if (cancelled) return;
        const valid = new Set(['dev', 'recall', 'schedule', 'tasks', 'community']);
        if (thread.preferredWorkspaceMode && valid.has(thread.preferredWorkspaceMode)) {
          setWorkspaceMode(thread.preferredWorkspaceMode as typeof workspaceMode);
        } else if (useChatStore.getState().workspaceMode === 'community') {
          setWorkspaceMode('dev');
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currentThreadId]); // eslint-disable-line react-hooks/exhaustive-deps
  // F120: Listen for port discovery via Socket.IO
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    import('socket.io-client').then(({ io }) => {
      if (cancelled) return;
      const apiUrl = new URL(API_URL);
      const socket = io(`${apiUrl.protocol}//${apiUrl.host}`, { transports: ['websocket'] });
      // Join worktree-scoped room for targeted preview events
      const room = worktreeId ? `worktree:${worktreeId}` : 'preview:global';
      socket.emit('join_room', room);
      const handler = (data: { port: number; framework?: string }) => {
        setPortDiscoveryToast(data);
        setTimeout(() => setPortDiscoveryToast(null), 8000);
      };
      socket.on('preview:port-discovered', handler);
      // F120: auto-open listener moved to ChatContainer (usePreviewAutoOpen hook)
      // WorkspacePanel consumes pendingPreviewAutoOpen from store on mount
      cleanup = () => {
        socket.off('preview:port-discovered', handler);
        socket.disconnect();
      };
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [worktreeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const [markdownRendered, setMarkdownRendered] = useState(true);
  const [htmlPreview, setHtmlPreview] = useState(false);
  const [jsxPreview, setJsxPreview] = useState(false);
  // F063: vertical resize — treeBasis as percentage (20-80), persisted
  const [treeBasis, setTreeBasis, resetTreeBasis] = usePersistedState('cat-cafe:treeBasis', 40);
  const panelRef = useRef<HTMLElement>(null);
  const handleVerticalResize = useCallback(
    (delta: number) => {
      if (!panelRef.current) return;
      const totalHeight = panelRef.current.offsetHeight;
      if (totalHeight === 0) return;
      const pct = (delta / totalHeight) * 100;
      setTreeBasis((prev) => Math.min(80, Math.max(20, prev + pct)));
    },
    [setTreeBasis],
  );

  // Reset markdown rendered mode when file changes (covers all entry points).
  // When a target line is set (e.g. from search), use raw mode so CodeMirror can scroll to it.
  useEffect(() => {
    setMarkdownRendered(!scrollToLine);
    setHtmlPreview(false);
  }, [scrollToLine]);

  const currentWorktree = worktrees.find((w) => w.id === worktreeId);

  const handleCite = useCallback(
    (path: string) => {
      const branch = currentWorktree?.branch;
      const wtTag = worktreeId ? `[wt:${worktreeId}]` : '';
      const suffix = branch ? ` ${wtTag}(🌿 ${branch})` : wtTag ? ` ${wtTag}` : '';
      setPendingChatInsert({ threadId: currentThreadId, text: `\`${path}\`${suffix}` });
    },
    [setPendingChatInsert, currentThreadId, currentWorktree, worktreeId],
  );

  // File management callbacks for WorkspaceTree
  const treeCallbacks = useMemo(
    () => ({
      onCreateFile: async (dirPath: string, name: string) => {
        const path = dirPath ? `${dirPath}/${name}` : name;
        const result = await createFile(path);
        if (result) {
          fetchTree();
          setOpenFile(path);
          setEditMode(true); // Auto-enter edit mode for new files
        }
        return !!result;
      },
      onCreateDir: async (dirPath: string, name: string) => {
        const path = dirPath ? `${dirPath}/${name}` : name;
        const result = await createDir(path);
        if (result) fetchTree();
        return !!result;
      },
      onDelete: async (path: string) => {
        const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
        if (
          !(await confirm({
            title: '删除确认',
            message: `删除 "${name}"？此操作不可撤销。`,
            variant: 'danger',
            confirmLabel: '删除',
          }))
        )
          return false;
        const ok = await deleteItem(path);
        if (ok) {
          closeTab(path);
          fetchTree();
        }
        return ok;
      },
      onRename: async (oldPath: string, newName: string) => {
        const dir = oldPath.includes('/') ? oldPath.slice(0, oldPath.lastIndexOf('/')) : '';
        const newPath = dir ? `${dir}/${newName}` : newName;
        const ok = await renameItem(oldPath, newPath);
        if (ok) {
          closeTab(oldPath);
          setOpenFile(newPath);
          fetchTree();
        }
        return ok;
      },
      onUpload: async (dirPath: string, files: FileList) => {
        for (const f of Array.from(files)) {
          const path = dirPath ? `${dirPath}/${f.name}` : f.name;
          await uploadFile(path, f);
        }
        fetchTree();
      },
    }),
    [createFile, createDir, deleteItem, renameItem, uploadFile, fetchTree, setOpenFile, closeTab, confirm],
  );

  const isMarkdown = !!(openFilePath && (openFilePath.endsWith('.md') || openFilePath.endsWith('.mdx')));
  const isHtml = !!(openFilePath && /\.html?$/i.test(openFilePath));
  const isJsx = !!(openFilePath && /\.[jt]sx$/i.test(openFilePath));

  return (
    <aside
      ref={panelRef}
      className="hidden lg:flex flex-1 min-w-0 border-l border-cafe bg-cafe-surface flex-col overflow-hidden animate-slide-in-right"
    >
      {/* ── Focus mode overlay ── */}
      {focusedPane === 'browser' && workspaceMode === 'dev' && viewMode === 'browser' ? (
        <WorkspacePreviewOnly
          initialPort={previewPort}
          initialPath={previewPath}
          onNavigate={handleBrowserNavigate}
          onExit={() => setFocusedPane(null)}
        />
      ) : focusedPane === 'file' && workspaceMode === 'dev' && viewMode === 'files' && file ? (
        <WorkspaceFocusShell onExit={() => setFocusedPane(null)}>
          <WorkspaceFileViewer
            file={file}
            openFilePath={openFilePath}
            openTabs={openTabs}
            canEdit={!!canEdit}
            editMode={editMode}
            isMarkdown={isMarkdown}
            isHtml={isHtml}
            isJsx={isJsx}
            markdownRendered={markdownRendered}
            htmlPreview={htmlPreview}
            jsxPreview={jsxPreview}
            saveError={saveError}
            scrollToLine={scrollToLine}
            worktreeId={worktreeId}
            currentWorktree={currentWorktree}
            setOpenFile={setOpenFile}
            closeTab={closeTab}
            onCloseCurrentTab={() => {
              if (openFilePath) closeTab(openFilePath);
              setEditMode(false);
            }}
            onToggleEdit={handleToggleEdit}
            onToggleMarkdownRendered={() => setMarkdownRendered((p) => !p)}
            onToggleHtmlPreview={() => setHtmlPreview((p) => !p)}
            onToggleJsxPreview={() => setJsxPreview((p) => !p)}
            onSave={handleSave}
            onDirtyChange={setEditDirty}
            pendingExternalSha={pendingExternalSha}
            onApplyExternalChange={applyExternalChange}
            onDismissExternalChange={dismissExternalChange}
            revealInFinder={revealInFinder}
          />
        </WorkspaceFocusShell>
      ) : focusedPane === 'changes' && workspaceMode === 'dev' && viewMode === 'changes' ? (
        <WorkspaceFocusShell onExit={() => setFocusedPane(null)}>
          <ChangesPanel worktreeId={worktreeId} basisPct={treeBasis} />
        </WorkspaceFocusShell>
      ) : focusedPane === 'git' && workspaceMode === 'dev' && viewMode === 'git' ? (
        <WorkspaceFocusShell onExit={() => setFocusedPane(null)}>
          <GitPanel />
        </WorkspaceFocusShell>
      ) : focusedPane === 'terminal' && workspaceMode === 'dev' && viewMode === 'terminal' ? (
        <WorkspaceFocusShell onExit={() => setFocusedPane(null)}>
          {worktreeId ? (
            <TerminalTab worktreeId={worktreeId} />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-cafe-muted">请先选择一个 Worktree</div>
          )}
        </WorkspaceFocusShell>
      ) : (
        <>
          {/* Header */}
          <div className="px-3 py-2.5 border-b border-cafe flex items-center justify-between bg-cafe-surface">
            <div className="flex items-center gap-2 min-w-0">
              <MenuIcon />
              <span className="text-sm font-semibold text-cafe-black">Workspace</span>
            </div>
            <button
              type="button"
              onClick={() => setRightPanelMode('status')}
              className="w-6 h-6 flex items-center justify-center rounded-md text-cafe-muted hover:text-cafe-secondary hover:bg-[var(--console-hover-bg)] transition-colors"
              title="切换到状态面板"
            >
              <CloseIcon />
            </button>
          </div>

          {/* Worktree indicator */}
          {currentWorktree && (
            <div className="px-3 py-2 border-b border-[var(--console-border-soft)] bg-[var(--console-shell-bg)]">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-conn-emerald-text flex-shrink-0" />
                <span className="text-xs font-medium text-cafe-black truncate">{currentWorktree.branch}</span>
                <span className="text-[10px] font-mono text-cafe-muted">{currentWorktree.head}</span>
              </div>
              {worktrees.length > 1 && (
                <div className="flex items-center gap-1 mt-1.5">
                  <select
                    value={worktreeId ?? ''}
                    onChange={(e) => setWorktreeId(e.target.value || null)}
                    className="flex-1 text-[10px] border border-[var(--console-border-soft)] rounded-md px-2 py-1 bg-cafe-surface/80 text-cafe-black focus:outline-none focus:border-cafe-accent"
                  >
                    {worktrees.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.head === 'linked' ? `📂 ${w.branch}` : `🌿 ${w.branch} (${w.head})`}
                      </option>
                    ))}
                  </select>
                  {worktreeId && <LinkedRootRemoveButton id={worktreeId} onRemoved={fetchWorktrees} />}
                </div>
              )}
              <LinkedRootsManager onRootsChanged={fetchWorktrees} />
            </div>
          )}

          {/* Search bar */}
          <form onSubmit={handleSearchSubmit} className="px-3 py-2 border-b border-[var(--console-border-soft)]">
            <div className="flex items-center gap-1.5 bg-cafe-surface/80 border border-[var(--console-border-soft)] rounded-lg px-2.5 py-1.5 focus-within:border-cafe-accent focus-within:ring-1 focus-within:ring-cafe-accent/20 transition-all">
              <SearchIcon />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setDidSearch(false);
                  if (!e.target.value.trim()) setSearchResults([]);
                }}
                onCompositionStart={searchIme.onCompositionStart}
                onCompositionEnd={searchIme.onCompositionEnd}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && searchIme.isComposing()) e.preventDefault();
                }}
                placeholder={
                  searchMode === 'content'
                    ? '搜索代码内容...'
                    : searchMode === 'filename'
                      ? '搜索文件名/路径...'
                      : '搜索全部...'
                }
                className="flex-1 text-xs bg-transparent text-cafe-black placeholder:text-cafe-muted focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setSearchMode((m) => (m === 'all' ? 'filename' : m === 'filename' ? 'content' : 'all'))}
                className={`text-[10px] px-1.5 py-0.5 rounded-md font-medium transition-colors ${
                  searchMode === 'all'
                    ? 'bg-cafe-accent/15 text-cafe-accent'
                    : searchMode === 'filename'
                      ? 'bg-[var(--console-hover-bg)] text-cafe-secondary'
                      : 'text-cafe-muted hover:text-cafe-secondary/60'
                }`}
                title={
                  searchMode === 'all'
                    ? '全部搜索（文件名+内容）→ 点击切换到仅文件名'
                    : searchMode === 'filename'
                      ? '文件名搜索 → 点击切换到仅内容'
                      : '内容搜索 → 点击切换到全部搜索'
                }
              >
                {searchMode === 'all' ? 'All' : searchMode === 'filename' ? 'File' : 'Aa'}
              </button>
            </div>
          </form>

          {/* Phase H: Workspace mode switcher */}
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-cafe-surface/50">
            <button
              type="button"
              onClick={() => setWorkspaceMode('dev')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-semibold transition-all ${
                workspaceMode === 'dev'
                  ? 'bg-[var(--console-hover-bg)] text-cafe-secondary border border-[var(--console-border-soft)]'
                  : 'text-cafe-muted hover:text-cafe-secondary/60'
              }`}
            >
              <span className="text-xs">&lt;/&gt;</span> 开发
            </button>
            <button
              type="button"
              onClick={() => setWorkspaceMode('recall')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-semibold transition-all ${
                workspaceMode === 'recall'
                  ? 'bg-cafe-accent/10 text-cafe-accent border border-cafe-accent/30'
                  : 'text-cafe-muted hover:text-cafe-secondary/60'
              }`}
            >
              <svg
                className="w-3 h-3"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
                <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
                <path d="M9 17l3 5v-5M15 17l-3 5" />
              </svg>
              记忆
            </button>
            <button
              type="button"
              onClick={() => setWorkspaceMode('schedule')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-semibold transition-all ${
                workspaceMode === 'schedule'
                  ? 'bg-[var(--console-hover-bg)] text-cafe-secondary border border-[var(--console-border-soft)]'
                  : 'text-cafe-muted hover:text-cafe-secondary/60'
              }`}
            >
              <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 0a8 8 0 110 16A8 8 0 018 0zm0 2a6 6 0 100 12A6 6 0 008 2zm.5 2v4.25l2.85 2.85a.5.5 0 01-.7.7L7.8 8.95A.5.5 0 017.5 8.6V4a.5.5 0 011 0z" />
              </svg>
              调度
            </button>
            <button
              type="button"
              onClick={() => setWorkspaceMode('tasks')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-semibold transition-all ${
                workspaceMode === 'tasks'
                  ? 'bg-[var(--console-hover-bg)] text-cafe-secondary border border-[var(--console-border-soft)]'
                  : 'text-cafe-muted hover:text-cafe-secondary/60'
              }`}
            >
              <svg
                className="w-3 h-3"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <circle cx="12" cy="12" r="1" />
              </svg>
              任务
            </button>
            <button
              type="button"
              onClick={() => setWorkspaceMode('community')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-semibold transition-all ${
                workspaceMode === 'community'
                  ? 'bg-[var(--console-hover-bg)] text-cafe-secondary border border-[var(--console-border-soft)]'
                  : 'text-cafe-muted hover:text-cafe-secondary/60'
              }`}
            >
              <svg
                className="w-3 h-3"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
              </svg>
              社区
            </button>
          </div>

          {/* Knowledge / Schedule / Tasks / Dev mode routing */}
          {workspaceMode === 'recall' ? (
            <div className="flex-1 min-h-0 overflow-y-auto">
              <RecallFeed />
            </div>
          ) : workspaceMode === 'schedule' ? (
            <SchedulePanel />
          ) : workspaceMode === 'tasks' ? (
            <TaskBoardPanel />
          ) : workspaceMode === 'community' ? (
            <CommunityPanel threadId={currentThreadId} />
          ) : (
            <>
              {/* Files / Changes toggle */}
              <div className="flex border-b border-[var(--console-border-soft)]">
                {(['files', 'changes', 'git', 'terminal', 'browser'] as const).map((mode) => {
                  const labels: Record<typeof mode, string> = {
                    files: 'Files',
                    changes: 'Changes',
                    git: 'Git',
                    terminal: 'Term',
                    browser: '🌐',
                  };
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setViewMode(mode)}
                      className={`flex-1 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                        viewMode === mode
                          ? 'text-cafe-accent border-b-2 border-cafe-accent'
                          : 'text-cafe-muted hover:text-cafe-secondary/60'
                      }`}
                    >
                      {labels[mode]}
                    </button>
                  );
                })}
              </div>

              {/* Error */}
              {error && (
                <div className="px-3 py-2 text-xs text-conn-red-text bg-conn-red-bg border-b border-conn-red-ring">
                  {error}
                </div>
              )}

              {/* F120: Port Discovery Toast — matches design Scene 2 */}
              {portDiscoveryToast && (
                <div className="console-card mx-3 my-2 p-4 rounded-xl">
                  <div className="flex items-start justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-cafe-accent text-base">◉</span>
                      <span className="text-sm font-semibold text-cafe-black">Dev Server Detected</span>
                    </div>
                    <button
                      type="button"
                      className="text-cafe-muted hover:text-cafe-secondary text-xs"
                      onClick={() => setPortDiscoveryToast(null)}
                    >
                      ✕
                    </button>
                  </div>
                  <p className="text-xs text-cafe-secondary ml-6 mb-3">
                    localhost:{portDiscoveryToast.port} is now listening
                    {portDiscoveryToast.framework && portDiscoveryToast.framework !== 'unknown'
                      ? ` (${portDiscoveryToast.framework})`
                      : ''}
                  </p>
                  <div className="flex items-center gap-2 ml-6">
                    <button
                      type="button"
                      className="console-button-primary px-3 py-1.5 text-xs font-medium"
                      onClick={() => {
                        setPreviewPort(portDiscoveryToast.port);
                        setViewMode('browser');
                        setPortDiscoveryToast(null);
                      }}
                    >
                      Open Preview
                    </button>
                    <button
                      type="button"
                      className="px-3 py-1.5 text-xs text-cafe-muted hover:text-cafe-secondary"
                      onClick={() => setPortDiscoveryToast(null)}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              )}

              {viewMode === 'browser' ? (
                <div className="relative flex-1 min-h-0 flex flex-col">
                  <FocusModeButton
                    disabled={!previewPort}
                    onClick={() => setFocusedPane('browser')}
                    className="absolute top-2 right-2 z-10"
                  />
                  <BrowserPanel
                    initialPort={previewPort}
                    initialPath={previewPath}
                    onNavigate={handleBrowserNavigate}
                  />
                </div>
              ) : viewMode === 'terminal' ? (
                <div className="relative flex-1 min-h-0 flex flex-col">
                  <FocusModeButton
                    disabled={!worktreeId}
                    onClick={() => setFocusedPane('terminal')}
                    className="absolute top-2 right-2 z-10"
                  />
                  {worktreeId ? (
                    <TerminalTab worktreeId={worktreeId} />
                  ) : (
                    <div className="flex items-center justify-center h-full text-sm text-cafe-muted">
                      请先选择一个 Worktree
                    </div>
                  )}
                </div>
              ) : viewMode === 'git' ? (
                <div className="relative flex-1 min-h-0 flex flex-col">
                  <FocusModeButton onClick={() => setFocusedPane('git')} className="absolute top-2 right-2 z-10" />
                  <GitPanel />
                </div>
              ) : viewMode === 'changes' ? (
                <div className="relative flex-1 min-h-0 flex flex-col">
                  <FocusModeButton
                    disabled={!worktreeId}
                    onClick={() => setFocusedPane('changes')}
                    className="absolute top-2 right-2 z-10"
                  />
                  <ChangesPanel worktreeId={worktreeId} basisPct={treeBasis} />
                </div>
              ) : (
                <>
                  {/* Search loading indicator */}
                  {searchLoading && (
                    <div className="border-b border-[var(--console-border-soft)] px-3 py-3 text-xs text-cafe-secondary flex items-center gap-2">
                      <span className="inline-block w-3 h-3 border-2 border-cafe-accent border-t-transparent rounded-full animate-spin" />
                      搜索中...
                    </div>
                  )}
                  {/* Search results — grouped when in 'all' mode */}
                  {(didSearch || searchResults.length > 0) &&
                    !searchLoading &&
                    !error &&
                    (() => {
                      const fileHits = searchResults.filter((r) => r.matchType === 'filename');
                      const contentHits = searchResults.filter((r) => r.matchType === 'content');
                      const isGrouped = fileHits.length > 0 || contentHits.length > 0;
                      return (
                        <div className="border-b border-[var(--console-border-soft)] max-h-64 overflow-y-auto">
                          {searchResults.length > 0 ? (
                            <>
                              {isGrouped && fileHits.length > 0 && (
                                <>
                                  <div className="px-3 py-1.5 text-[10px] text-cafe-muted font-semibold uppercase tracking-wider sticky top-0 bg-cafe-white/95 backdrop-blur-sm">
                                    文件名匹配 ({fileHits.length})
                                  </div>
                                  {fileHits.map((r, i) => (
                                    <SearchResultItem
                                      key={`f:${r.path}:${i}`}
                                      path={r.path}
                                      line={0}
                                      content=""
                                      query={searchQuery}
                                      onClick={() => handleSearchResultClick(r.path, 0)}
                                    />
                                  ))}
                                </>
                              )}
                              {isGrouped && contentHits.length > 0 && (
                                <>
                                  <div className="px-3 py-1.5 text-[10px] text-cafe-muted font-semibold uppercase tracking-wider sticky top-0 bg-cafe-white/95 backdrop-blur-sm">
                                    内容匹配 ({contentHits.length})
                                  </div>
                                  {contentHits.map((r, i) => (
                                    <SearchResultItem
                                      key={`c:${r.path}:${r.line}:${i}`}
                                      path={r.path}
                                      line={r.line}
                                      content={r.content}
                                      query={searchQuery}
                                      onClick={() => handleSearchResultClick(r.path, r.line)}
                                    />
                                  ))}
                                </>
                              )}
                              {!isGrouped && (
                                <>
                                  <div className="px-3 py-1.5 text-[10px] text-cafe-muted font-semibold uppercase tracking-wider sticky top-0 bg-cafe-white/95 backdrop-blur-sm">
                                    {searchResults.length} 个结果
                                  </div>
                                  {searchResults.map((r, i) => (
                                    <SearchResultItem
                                      key={`${r.path}:${r.line}:${i}`}
                                      path={r.path}
                                      line={r.line}
                                      content={r.content}
                                      query={searchQuery}
                                      onClick={() => handleSearchResultClick(r.path, r.line)}
                                    />
                                  ))}
                                </>
                              )}
                            </>
                          ) : (
                            <div className="px-3 py-3 text-xs text-cafe-secondary">
                              <div className="font-medium text-cafe-black">
                                未在 {currentWorktree?.branch ?? '当前工作区'} 中找到 “{searchQuery.trim()}”
                              </div>
                              <div className="mt-1 text-[11px] text-cafe-muted">
                                当前模式：
                                {searchMode === 'all' ? '全部' : searchMode === 'filename' ? '文件名' : '内容'}
                                {searchMode === 'content' ? '。可以试试切到 File 或 All。' : '。'}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })()}

                  {/* File tree */}
                  <WorkspaceTree
                    tree={tree}
                    loading={loading}
                    expandedPaths={expandedPaths}
                    toggleExpand={toggleExpand}
                    onSelect={handleFileSelect}
                    onCite={handleCite}
                    selectedPath={openFilePath}
                    hasFile={!!file}
                    basisPct={treeBasis}
                    callbacks={treeCallbacks}
                  />

                  {/* Vertical resize handle + File viewer (extracted) */}
                  {(file || openTabs.length > 0) && (
                    <>
                      <ResizeHandle
                        direction="vertical"
                        onResize={handleVerticalResize}
                        onDoubleClick={resetTreeBasis}
                      />
                      {file && (
                        <WorkspaceFileViewer
                          file={file}
                          openFilePath={openFilePath}
                          openTabs={openTabs}
                          canEdit={!!canEdit}
                          editMode={editMode}
                          isMarkdown={isMarkdown}
                          isHtml={isHtml}
                          isJsx={isJsx}
                          markdownRendered={markdownRendered}
                          htmlPreview={htmlPreview}
                          jsxPreview={jsxPreview}
                          saveError={saveError}
                          scrollToLine={scrollToLine}
                          worktreeId={worktreeId}
                          currentWorktree={currentWorktree}
                          setOpenFile={setOpenFile}
                          closeTab={closeTab}
                          onCloseCurrentTab={() => {
                            if (openFilePath) closeTab(openFilePath);
                            setEditMode(false);
                          }}
                          onToggleEdit={handleToggleEdit}
                          onToggleMarkdownRendered={() => setMarkdownRendered((p) => !p)}
                          onToggleHtmlPreview={() => setHtmlPreview((p) => !p)}
                          onToggleJsxPreview={() => setJsxPreview((p) => !p)}
                          onSave={handleSave}
                          onDirtyChange={setEditDirty}
                          pendingExternalSha={pendingExternalSha}
                          onApplyExternalChange={applyExternalChange}
                          onDismissExternalChange={dismissExternalChange}
                          revealInFinder={revealInFinder}
                          onFocusMode={() => setFocusedPane('file')}
                        />
                      )}
                    </>
                  )}
                </> /* end viewMode=files */
              )}
            </>
          )}
        </> /* end non-focus-mode */
      )}
    </aside>
  );
}
