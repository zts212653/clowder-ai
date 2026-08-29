'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFileEditing } from '@/hooks/useFileEditing';
import { useFileManagement } from '@/hooks/useFileManagement';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { usePersistedState } from '@/hooks/usePersistedState';
import type { TreeNode } from '@/hooks/useWorkspace';
import { useWorkspace } from '@/hooks/useWorkspace';
import { isWorkspaceMode, WORKSPACE_MODE_META } from '@/lib/workspace-modes';
import { useChatStore } from '@/stores/chatStore';
import { API_URL, apiFetch } from '@/utils/api-client';
import { worktreeBasename, worktreeLabel } from '@/utils/worktree-label';
import { ApprovalPanel } from './ApprovalPanel';
import { ArtifactsPanel } from './ArtifactsPanel';
import { CommunityPanel } from './CommunityPanel';
import { createFileContextAttachment } from './chat-context-reference';
import { EvalWorkspacePanel } from './eval-workspace/EvalWorkspacePanel';
import { EventTimeline } from './event-memory/EventTimeline';
import { ListenModePlayer } from './listen-mode/ListenModePlayer';
import { RecallFeed } from './memory/RecallFeed';
import { RecallLedger } from './memory/RecallLedger';
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
import { TrajectoryPanel } from './workspace/trajectory/TrajectoryPanel';
import { WorkspaceFileViewer } from './workspace/WorkspaceFileViewer';
import { WorkspaceFocusShell } from './workspace/WorkspaceFocusShell';
import { type WorkspaceDevSurface, WorkspaceLauncher } from './workspace/WorkspaceLauncher';
import { WorkspaceNowSurface } from './workspace/WorkspaceNowSurface';
import { WorkspacePreviewOnly } from './workspace/WorkspacePreviewOnly';
import { WorkspaceSurfaceHeader } from './workspace/WorkspaceSurfaceHeader';
import { WorkspaceTree } from './workspace/WorkspaceTree';

/** Find a node in a tree by path (DFS) */
function findNode(nodes: TreeNode[], path: string): TreeNode | undefined {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children && path.startsWith(`${n.path}/`)) {
      const found = findNode(n.children, path);
      if (found) return found;
    }
  }
  return undefined;
}

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
        <mark className="bg-cafe-surface-sunken text-cafe-interactive rounded px-0.5">
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
      className="w-full text-left px-3 py-1.5 hover:bg-cafe-surface/60 transition-colors group"
    >
      <div className="flex items-center gap-1.5">
        <FileIcon name={fileName} />
        <span className="text-xs font-medium text-cafe-black truncate">{fileName}</span>
        {line > 0 && <span className="text-micro text-cafe-interactive/50 font-mono">:{line}</span>}
      </div>
      {dir && <div className="text-micro text-cafe-muted truncate ml-5">{dir}</div>}
      {content && <div className="text-micro text-cafe-secondary truncate font-mono ml-5 mt-0.5">{highlighted}</div>}
    </button>
  );
}

/* ── SVG micro-icons ─────────────────────────── */
const SearchIcon = () => (
  <svg
    className="w-3.5 h-3.5 text-cafe-interactive/40 flex-shrink-0"
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
  >
    <path
      fillRule="evenodd"
      d="M9.965 11.026a5 5 0 1 1 1.06-1.06l2.755 2.754a.75.75 0 1 1-1.06 1.06l-2.755-2.754ZM10.5 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z"
      clipRule="evenodd"
    />
  </svg>
);

function PresentationLockButton({ locked, onToggle }: { locked: boolean; onToggle: () => void }) {
  const label = locked ? '解锁当前文件视图' : '锁定当前文件视图';
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-micro font-semibold transition-colors ${
        locked
          ? 'bg-cafe-accent/10 text-cafe-accent hover:bg-cafe-accent/20'
          : 'text-cafe-interactive/40 hover:bg-cafe-surface-sunken/60 hover:text-cafe-interactive'
      }`}
      title={
        locked
          ? '点击退出锁定 — 恢复各 thread 自己的文件视图'
          : '锁定当前文件视图 — 切换 thread 时右侧保持不变，适合演示/讲解'
      }
      aria-label={label}
      aria-pressed={locked}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        {locked ? (
          <path d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-1.5V4.5A3.5 3.5 0 0 0 8 1Zm2 5H6V4.5a2 2 0 1 1 4 0V6Z" />
        ) : (
          <path d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1H6V4.5a2 2 0 1 1 4 0 .75.75 0 0 0 1.5 0A3.5 3.5 0 0 0 8 1Z" />
        )}
      </svg>
      <span className="hidden 2xl:inline">{locked ? '已锁定' : '锁定'}</span>
    </button>
  );
}

export function WorkspacePanel({
  threadId,
  defaultCatId = 'opus',
  onOpenStatus,
}: {
  threadId?: string;
  defaultCatId?: string;
  onOpenStatus?: () => void;
}) {
  const confirm = useConfirm();
  const {
    worktrees,
    worktreeId,
    tree,
    file,
    searchResults,
    loading,
    worktreesLoading,
    worktreesError,
    searchLoading,
    searchError,
    error,
    search,
    resetSearch,
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
  const workspaceFileSetAt = useChatStore((s) => s._workspaceFileSetAt);
  const setPendingChatInsert = useChatStore((s) => s.setPendingChatInsert);
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const { editMode, setEditMode, saveError, canEdit, handleToggleEdit, handleSave } = useFileEditing({
    worktreeId,
    openFilePath,
    file,
    fetchFile,
  });

  const pendingPreviewAutoOpen = useChatStore((s) => s.pendingPreviewAutoOpen);
  const consumePreviewAutoOpen = useChatStore((s) => s.consumePreviewAutoOpen);
  const storeRevealPath = useChatStore((s) => s.workspaceRevealPath);
  const setStoreRevealPath = useChatStore((s) => s.setWorkspaceRevealPath);
  const presentationLock = useChatStore((s) => s.presentationLock);
  const enablePresentationLock = useChatStore((s) => s.enablePresentationLock);
  const disablePresentationLock = useChatStore((s) => s.disablePresentationLock);
  const setPresentationLockViewport = useChatStore((s) => s.setPresentationLockViewport);
  const workspaceScrollTop = useChatStore((s) => s.workspaceScrollTop);
  // F226: presentation surface — tear-off current file into a floating window
  const detachToFloat = useChatStore((s) => s.detachToFloat);
  const presentationSurface = useChatStore((s) => s.presentationSurface);
  const { createFile, createDir, deleteItem, renameItem, uploadFile } = useFileManagement();

  const viewportRestoreKey = `${currentThreadId}:${openFilePath}`;
  const handleScrollTopChange = useCallback(
    (scrollTop: number) => {
      setPresentationLockViewport(scrollTop);
    },
    [setPresentationLockViewport],
  );

  const viewMode = useChatStore((s) => s.workspaceSurface);
  const setViewMode = useChatStore((s) => s.setWorkspaceSurface);
  const restoreViewMode = useChatStore((s) => s.restoreWorkspaceSurface);
  // F227: recall mode sub-tab — 记忆流 (RecallFeed) vs 拉闸记录 (EventTimeline) vs 账本 (RecallLedger, F263)
  const [recallTab, setRecallTab] = useState<'feed' | 'events' | 'ledger'>('feed');
  // Phase H: Workspace mode switcher (dev tools vs knowledge feed)
  const workspaceMode = useChatStore((s) => s.workspaceMode);
  const setWorkspaceMode = useChatStore((s) => s.setWorkspaceMode);
  const restoreWorkspaceMode = useChatStore((s) => s.restoreWorkspaceMode);
  const workspacePreview = useChatStore((s) => s.workspacePreview);
  const setWorkspacePreview = useChatStore((s) => s.setWorkspacePreview);
  const previewPort = workspacePreview.port;
  const previewPath = workspacePreview.path;
  const [focusedPane, setFocusedPane] = useState<'browser' | 'changes' | 'file' | 'git' | 'terminal' | null>(null);
  const previousOpenFilePathRef = useRef(openFilePath);
  const previousWorkspaceFileSetTsRef = useRef(workspaceFileSetAt.ts);

  // Keep parent state in sync with BrowserPanel navigation (focus mode state preservation)
  const handleBrowserNavigate = useCallback(
    (port: number, path: string) => setWorkspacePreview({ port, path }),
    [setWorkspacePreview],
  );

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

  // F120: Consume pending auto-open from always-mounted listener (ChatContainer)
  useEffect(() => {
    if (!pendingPreviewAutoOpen) return;
    const data = consumePreviewAutoOpen();
    if (data) {
      setWorkspacePreview(data);
      setViewMode('browser');
    }
  }, [pendingPreviewAutoOpen, consumePreviewAutoOpen, setViewMode, setWorkspacePreview]);

  useEffect(() => {
    const previousOpenFilePath = previousOpenFilePathRef.current;
    const previousWorkspaceFileSetTs = previousWorkspaceFileSetTsRef.current;
    previousOpenFilePathRef.current = openFilePath;
    previousWorkspaceFileSetTsRef.current = workspaceFileSetAt.ts;

    const freshOpenForCurrentThread =
      workspaceFileSetAt.ts !== previousWorkspaceFileSetTs &&
      (!workspaceFileSetAt.threadId || workspaceFileSetAt.threadId === currentThreadId);
    if (!openFilePath || (openFilePath === previousOpenFilePath && !freshOpenForCurrentThread)) return;
    if (freshOpenForCurrentThread) {
      setViewMode('files');
    } else {
      restoreViewMode('files');
    }
  }, [currentThreadId, openFilePath, restoreViewMode, setViewMode, workspaceFileSetAt.threadId, workspaceFileSetAt.ts]);
  const [portDiscoveryToast, setPortDiscoveryToast] = useState<{ port: number; framework?: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'content' | 'filename' | 'all'>('all');
  const [didSearch, setDidSearch] = useState(false);
  const searchIme = useIMEGuard();
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  /** Progressive reveal: store target path, expand ancestors as tree loads deeper. */
  const [pendingRevealPath, setPendingRevealPath] = useState<string | null>(null);

  useEffect(() => {
    if (!storeRevealPath) return;
    setPendingRevealPath(storeRevealPath);
    setViewMode('files');
    setStoreRevealPath(null);
  }, [setStoreRevealPath, setViewMode, storeRevealPath]);

  // G7-2: Per-thread expandedPaths cache — tabs/openFile are now in store-level ThreadState
  // (snapshotActive/flattenThread handle save/restore automatically on setCurrentThread)
  const expandedPathsCache = useRef<Map<string, Set<string>>>(new Map());
  const prevThreadRef = useRef<string | null>(null);
  useEffect(() => {
    const prevThread = prevThreadRef.current;
    if (prevThread && prevThread !== currentThreadId) {
      expandedPathsCache.current.set(prevThread, new Set(expandedPaths));
    }
    if (currentThreadId && currentThreadId !== prevThread) {
      const cached = expandedPathsCache.current.get(currentThreadId);
      setExpandedPaths(cached ?? new Set());
      setPendingRevealPath(null);
    }
    prevThreadRef.current = currentThreadId;
  }, [currentThreadId]); // eslint-disable-line react-hooks/exhaustive-deps
  // F168: Auto-switch workspace mode based on thread's preferredWorkspaceMode.
  // Also resets from 'community' when switching to a thread without a preference,
  // preventing mode leakage across threads.
  // F063 AC-PL6: skip auto-switch when presentation lock is active to preserve focus mode.
  useEffect(() => {
    if (!currentThreadId) return;
    if (presentationLock) return;
    let cancelled = false;
    apiFetch(`/api/threads/${currentThreadId}`)
      ?.then((res) => res.json())
      .then((thread: { preferredWorkspaceMode?: string }) => {
        if (cancelled) return;
        const currentWorkspace = useChatStore.getState();
        // F120 explicit preview delivery outranks a thread's default landing
        // mode. Without this post-fetch guard, a slow preferred-mode response
        // can put Approval history back on top after the receipt said applied.
        if (
          currentWorkspace.workspaceMode === 'dev' &&
          currentWorkspace.workspaceSurface === 'browser' &&
          currentWorkspace.rightPanelMode === 'workspace' &&
          currentWorkspace.rightPanelOpen
        ) {
          return;
        }
        if (isWorkspaceMode(thread.preferredWorkspaceMode)) {
          restoreWorkspaceMode(thread.preferredWorkspaceMode);
        } else if (['community', 'artifacts'].includes(useChatStore.getState().workspaceMode)) {
          restoreWorkspaceMode('dev');
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currentThreadId, presentationLock, restoreWorkspaceMode]);
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
      // F120: auto-open listener lives on the stable main useSocket connection.
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
  // F063: vertical resize — treeBasis as percentage (20-80), persisted.
  const [treeBasis, setTreeBasis, resetTreeBasis] = usePersistedState('cat-cafe:treeBasis', 40);
  const panelRef = useRef<HTMLElement>(null);
  const handleVerticalResize = useCallback(
    (delta: number) => {
      if (!panelRef.current) return;
      const totalHeight = panelRef.current.offsetHeight;
      if (totalHeight === 0) return;
      const pct = (delta / totalHeight) * 100;
      setTreeBasis((previous) => Math.min(80, Math.max(20, previous + pct)));
    },
    [setTreeBasis],
  );

  const toggleExpand = useCallback(
    (path: string) => {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          // Lazy-load: if the directory has no children loaded, fetch subtree
          const node = findNode(tree, path);
          if (node && node.type === 'directory' && node.children === undefined) {
            void fetchSubtree(path);
          }
        }
        return next;
      });
    },
    [tree, fetchSubtree],
  );

  const handleFileSelect = useCallback(
    (path: string) => {
      setOpenFile(path);
      setViewMode('files');
      resetSearch();
      setDidSearch(false);
      setEditMode(false);
    },
    [resetSearch, setEditMode, setOpenFile, setViewMode],
  );

  const handleSearchSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmedQuery = searchQuery.trim();
      if (!trimmedQuery) {
        setDidSearch(false);
        resetSearch();
        return;
      }
      setDidSearch(true);
      void search(trimmedQuery, searchMode);
    },
    [resetSearch, searchQuery, searchMode, search],
  );

  const revealInTree = useCallback((filePath: string) => {
    setPendingRevealPath(filePath);
  }, []);

  // Progressively expand ancestors each time the tree updates with new nodes.
  useEffect(() => {
    if (!pendingRevealPath) return;
    const parts = pendingRevealPath.split('/');
    const ancestors: string[] = [];
    for (let i = 1; i < parts.length; i++) {
      ancestors.push(parts.slice(0, i).join('/'));
    }
    let needsFetch = false;
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      for (const dir of ancestors) {
        next.add(dir);
        const node = findNode(tree, dir);
        if (node && node.type === 'directory' && node.children === undefined) {
          void fetchSubtree(dir);
          needsFetch = true;
        }
        if (!node) {
          // Node not yet in tree — parent needs to load first, wait for next tree update
          needsFetch = true;
          break;
        }
      }
      return next;
    });
    // All ancestors are in the tree and expanded — reveal complete
    if (!needsFetch) {
      setPendingRevealPath(null);
    }
  }, [pendingRevealPath, tree, fetchSubtree]);

  const handleSearchResultClick = useCallback(
    (path: string, line: number) => {
      setOpenFile(path, line);
      setViewMode('files');
      resetSearch();
      setDidSearch(false);
      setEditMode(false);
      revealInTree(path);
    },
    [resetSearch, revealInTree, setEditMode, setOpenFile, setViewMode],
  );

  const handleLauncherSearch = useCallback(
    async (query: string) => {
      await search(query, 'all');
    },
    [search],
  );

  const handleLauncherViewAll = useCallback(
    (query: string) => {
      setSearchQuery(query);
      setDidSearch(true);
      setViewMode('files');
    },
    [setViewMode],
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
      setPendingChatInsert({
        threadId: currentThreadId,
        text: '',
        contextAttachments: [
          createFileContextAttachment(path, worktreeId, {
            ...(currentWorktree?.branch ? { branch: currentWorktree.branch } : {}),
          }),
        ],
      });
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
          setEditMode(true);
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
    [createFile, createDir, deleteItem, renameItem, uploadFile, fetchTree, setOpenFile, closeTab, confirm, setEditMode],
  );

  const isMarkdown = !!(openFilePath && (openFilePath.endsWith('.md') || openFilePath.endsWith('.mdx')));
  const isHtml = !!(openFilePath && /\.html?$/i.test(openFilePath));
  const isJsx = !!(openFilePath && /\.[jt]sx$/i.test(openFilePath));

  const surfaceTitle =
    workspaceMode === 'dev'
      ? viewMode === 'home'
        ? 'Workspace'
        : viewMode === 'files'
          ? '文件'
          : viewMode === 'changes'
            ? '变更'
            : viewMode === 'git'
              ? 'Git'
              : viewMode === 'terminal'
                ? '终端'
                : '浏览器预览'
      : WORKSPACE_MODE_META[workspaceMode].label;
  const surfaceDetail = workspaceMode === 'dev' ? undefined : WORKSPACE_MODE_META[workspaceMode].description;

  return (
    <aside
      ref={panelRef}
      className="flex flex-1 min-w-0 bg-[var(--console-panel-bg)] flex-col overflow-hidden animate-slide-in-right"
    >
      <ListenModePlayer />
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
            restoreScrollTop={presentationLock ? workspaceScrollTop : undefined}
            restoreKey={presentationLock ? viewportRestoreKey : undefined}
            onScrollTopChange={presentationLock ? handleScrollTopChange : undefined}
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
            <div className="flex items-center justify-center h-full text-sm text-cafe-interactive/50">
              先在上方选择或连接一个工作区
            </div>
          )}
        </WorkspaceFocusShell>
      ) : (
        <>
          {!(workspaceMode === 'dev' && viewMode === 'home') && (
            <WorkspaceSurfaceHeader
              title={surfaceTitle}
              detail={surfaceDetail}
              onBack={() => {
                setWorkspaceMode('dev');
                setViewMode('home');
              }}
              actions={
                <>
                  {/* F063/F226 actions keep their original owners; F284 only moves them into object chrome. */}
                  {workspaceMode === 'dev' && (
                    <>
                      <PresentationLockButton
                        locked={!!presentationLock}
                        onToggle={presentationLock ? disablePresentationLock : enablePresentationLock}
                      />
                      <button
                        type="button"
                        onClick={detachToFloat}
                        disabled={!openFilePath || !!presentationSurface}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-micro font-semibold text-cafe-interactive/40 transition-colors hover:bg-cafe-surface-sunken/60 hover:text-cafe-interactive disabled:cursor-not-allowed disabled:opacity-30"
                        title="浮出文档窗口 — 讲稿浮起来，右侧腾出来切定时任务/记忆/毛线球"
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          aria-hidden="true"
                        >
                          <path
                            d="M5 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2M9 2h5v5M14 2 7 9"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        <span className="hidden 2xl:inline">浮出</span>
                      </button>
                    </>
                  )}
                </>
              }
            />
          )}

          {workspaceMode === 'dev' && viewMode !== 'home' && (
            <div
              data-testid="workspace-source-bar"
              className="relative flex flex-wrap items-center gap-2 border-b border-cafe-subtle/45 bg-cafe-surface/15 px-3 py-2"
            >
              {worktrees.length > 0 ? (
                <>
                  <span className="h-2 w-2 shrink-0 rounded-full bg-conn-green-text" aria-hidden="true" />
                  <select
                    value={worktreeId ?? ''}
                    onChange={(event) => setWorktreeId(event.target.value || null)}
                    className="h-8 min-w-0 flex-1 rounded-lg border border-cafe-subtle/70 bg-cafe-surface/80 px-2 text-xs font-medium text-cafe-black outline-none focus:border-cafe-accent"
                    aria-label="当前工作区"
                    title={worktrees.find((worktree) => worktree.id === worktreeId)?.root}
                  >
                    {!worktreeId && <option value="">选择一个工作区</option>}
                    {worktrees.map((worktree) => (
                      <option key={worktree.id} value={worktree.id} title={worktree.root}>
                        {worktreeLabel(worktree)}
                      </option>
                    ))}
                  </select>
                  {worktreesLoading && <output className="shrink-0 text-micro text-cafe-muted">更新中…</output>}
                </>
              ) : worktreesLoading ? (
                <span data-testid="workspace-discovery-status" className="min-w-0 flex-1 text-xs text-cafe-secondary">
                  正在查找可用工作区…
                </span>
              ) : (
                <>
                  <span data-testid="workspace-discovery-status" className="min-w-0 flex-1 text-xs text-cafe-secondary">
                    {worktreesError ? '工作区列表暂时不可用' : '没有找到可用工作区'}
                  </span>
                  <button
                    type="button"
                    onClick={() => void fetchWorktrees()}
                    className="h-7 shrink-0 rounded-lg px-2 text-micro font-semibold text-cafe-accent transition-colors hover:bg-cafe-accent/8"
                  >
                    重新查找
                  </button>
                </>
              )}
              {worktreeId && <LinkedRootRemoveButton id={worktreeId} onRemoved={fetchWorktrees} />}
              {!worktreesLoading && (
                <details className="relative shrink-0">
                  <summary
                    aria-label="工作区更多操作"
                    className="flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded-lg text-sm font-semibold text-cafe-muted transition-colors hover:bg-cafe-surface-sunken hover:text-cafe-accent"
                    title="工作区更多操作"
                  >
                    ···
                  </summary>
                  <div className="absolute right-0 top-9 z-30 w-72 rounded-xl border border-cafe-subtle/70 bg-cafe-surface p-2 shadow-lg">
                    <LinkedRootsManager compact onRootsChanged={fetchWorktrees} />
                  </div>
                </details>
              )}
            </div>
          )}

          {/* Knowledge / Schedule / Tasks / Artifacts / Approval / Eval / Dev mode routing */}
          {workspaceMode === 'recall' ? (
            <div className="flex-1 min-h-0 flex flex-col">
              {/* F227+F263: 记忆流 vs 拉闸记录 vs 账本 */}
              <div className="flex gap-1 px-3 py-1.5 border-b border-cafe-subtle/40">
                {(['feed', 'events', 'ledger'] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setRecallTab(tab)}
                    className={`px-2.5 py-1 rounded-full text-micro font-semibold transition-all ${
                      recallTab === tab
                        ? 'bg-cafe-accent/10 text-cafe-accent border border-cafe-accent/30'
                        : 'text-cafe-interactive/40 hover:text-cafe-interactive/60'
                    }`}
                  >
                    {tab === 'feed' ? '记忆流' : tab === 'events' ? '拉闸记录' : '账本'}
                  </button>
                ))}
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto">
                {recallTab === 'feed' ? <RecallFeed /> : recallTab === 'events' ? <EventTimeline /> : <RecallLedger />}
              </div>
            </div>
          ) : workspaceMode === 'schedule' ? (
            <SchedulePanel />
          ) : workspaceMode === 'tasks' ? (
            <TaskBoardPanel />
          ) : workspaceMode === 'community' ? (
            <CommunityPanel threadId={currentThreadId} />
          ) : workspaceMode === 'artifacts' ? (
            currentThreadId ? (
              <ArtifactsPanel threadId={currentThreadId} />
            ) : (
              <div className="flex-1 flex items-center justify-center text-cafe-secondary text-sm">
                选择一个对话以查看产物
              </div>
            )
          ) : workspaceMode === 'approval' ? (
            <ApprovalPanel />
          ) : workspaceMode === 'eval' ? (
            <EvalWorkspacePanel />
          ) : workspaceMode === 'trajectory' ? (
            <TrajectoryPanel threadId={currentThreadId} />
          ) : (
            <>
              {/* Error */}
              {error && (
                <div className="px-3 py-2 text-xs text-conn-red-text bg-conn-red-bg/80 border-b border-conn-red-ring">
                  {error}
                </div>
              )}

              {/* F120: Port Discovery Toast — matches design Scene 2 */}
              {portDiscoveryToast && (
                <div className="mx-3 my-2 p-4 rounded-xl bg-cafe-surface shadow-md border border-[var(--console-border-soft)]">
                  <div className="flex items-start justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-cafe-accent text-base">◉</span>
                      <span className="text-sm font-semibold text-cafe">Dev Server Detected</span>
                    </div>
                    <button
                      type="button"
                      className="text-cafe-muted hover:text-cafe text-xs"
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
                      className="px-3 py-1.5 rounded-md bg-cafe-accent text-[var(--cafe-surface)] text-xs font-medium hover:bg-cafe-accent-hover transition-colors"
                      onClick={() => {
                        setWorkspacePreview({ port: portDiscoveryToast.port, path: '/' });
                        setViewMode('browser');
                        setPortDiscoveryToast(null);
                      }}
                    >
                      Open Preview
                    </button>
                    <button
                      type="button"
                      className="px-3 py-1.5 text-xs text-cafe-secondary hover:text-cafe"
                      onClick={() => setPortDiscoveryToast(null)}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              )}

              {viewMode === 'home' ? (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <WorkspaceNowSurface
                    repository={
                      currentWorktree
                        ? { name: worktreeBasename(currentWorktree.root), branch: currentWorktree.branch }
                        : undefined
                    }
                  />
                  <WorkspaceLauncher
                    onSelectDevSurface={(surface: WorkspaceDevSurface) => setViewMode(surface)}
                    onOpenStatus={onOpenStatus}
                    threadId={threadId}
                    defaultCatId={defaultCatId}
                    workspaceSearch={{
                      enabled: !!worktreeId,
                      results: searchResults,
                      loading: searchLoading,
                      error: searchError,
                      onSearch: handleLauncherSearch,
                      onReset: resetSearch,
                      onOpenResult: handleSearchResultClick,
                      onViewAll: handleLauncherViewAll,
                    }}
                    actions={
                      <PresentationLockButton
                        locked={!!presentationLock}
                        onToggle={presentationLock ? disablePresentationLock : enablePresentationLock}
                      />
                    }
                  />
                </div>
              ) : viewMode === 'browser' ? (
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
                    <div className="flex items-center justify-center h-full text-sm text-cafe-interactive/50">
                      先在上方选择或连接一个工作区
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
                  <form onSubmit={handleSearchSubmit} className="border-b border-cafe-subtle/40 px-3 py-2">
                    <div className="flex items-center gap-1.5 rounded-lg border border-cafe-subtle bg-cafe-surface/80 px-2.5 py-1.5 transition-all focus-within:border-cafe-accent focus-within:ring-1 focus-within:ring-cafe-accent/20">
                      <SearchIcon />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(event) => {
                          setSearchQuery(event.target.value);
                          setDidSearch(false);
                          if (!event.target.value.trim()) resetSearch();
                        }}
                        onCompositionStart={searchIme.onCompositionStart}
                        onCompositionEnd={searchIme.onCompositionEnd}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && searchIme.isComposing()) event.preventDefault();
                        }}
                        placeholder={
                          searchMode === 'content'
                            ? '搜索代码内容…'
                            : searchMode === 'filename'
                              ? '搜索文件名或路径…'
                              : '搜索当前工作区…'
                        }
                        className="min-w-0 flex-1 bg-transparent text-xs text-cafe-black outline-none placeholder:text-cafe-interactive/30"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setSearchMode((mode) =>
                            mode === 'all' ? 'filename' : mode === 'filename' ? 'content' : 'all',
                          )
                        }
                        className={`rounded-md px-1.5 py-0.5 text-micro font-medium transition-colors ${
                          searchMode === 'all'
                            ? 'bg-cafe-accent/15 text-cafe-accent'
                            : searchMode === 'filename'
                              ? 'bg-cafe-surface-sunken text-cafe-interactive'
                              : 'text-cafe-interactive/40 hover:text-cafe-interactive/60'
                        }`}
                        title="切换搜索范围"
                      >
                        {searchMode === 'all' ? 'All' : searchMode === 'filename' ? 'File' : 'Aa'}
                      </button>
                    </div>
                  </form>

                  {/* Search loading indicator */}
                  {searchLoading && (
                    <div className="border-b border-cafe-subtle/40 px-3 py-3 text-xs text-cafe-interactive/70 flex items-center gap-2">
                      <span className="inline-block w-3 h-3 border-2 border-cafe-accent border-t-transparent rounded-full animate-spin" />
                      搜索中...
                    </div>
                  )}
                  {searchError && !searchLoading && (
                    <div className="border-b border-conn-red-ring bg-conn-red-bg/80 px-3 py-3 text-xs text-conn-red-text">
                      暂时没能搜索当前工作区，请重试。
                    </div>
                  )}
                  {/* Search results — grouped when in 'all' mode */}
                  {(didSearch || searchResults.length > 0) &&
                    !searchLoading &&
                    !searchError &&
                    (() => {
                      const fileHits = searchResults.filter((r) => r.matchType === 'filename');
                      const contentHits = searchResults.filter((r) => r.matchType === 'content');
                      const isGrouped = fileHits.length > 0 || contentHits.length > 0;
                      return (
                        <div className="border-b border-cafe-subtle/40 max-h-64 overflow-y-auto">
                          {searchResults.length > 0 ? (
                            <>
                              {isGrouped && fileHits.length > 0 && (
                                <>
                                  <div className="px-3 py-1.5 text-micro text-cafe-interactive/50 font-semibold uppercase tracking-wider sticky top-0 bg-cafe-white/95 backdrop-blur-sm">
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
                                  <div className="px-3 py-1.5 text-micro text-cafe-interactive/50 font-semibold uppercase tracking-wider sticky top-0 bg-cafe-white/95 backdrop-blur-sm">
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
                                  <div className="px-3 py-1.5 text-micro text-cafe-interactive/50 font-semibold uppercase tracking-wider sticky top-0 bg-cafe-white/95 backdrop-blur-sm">
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
                            <div className="px-3 py-3 text-xs text-cafe-interactive/70">
                              <div className="font-medium text-cafe-black">
                                未在 {currentWorktree?.branch ?? '当前工作区'} 中找到 “{searchQuery.trim()}”
                              </div>
                              <div className="mt-1 text-xs text-cafe-interactive/55">
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
                    emptyTitle={
                      worktreeId
                        ? '这个工作区还没有文件'
                        : worktreesLoading
                          ? '正在查找工作区'
                          : worktreesError
                            ? '暂时没能读取工作区'
                            : '没有找到可用工作区'
                    }
                    emptyDescription={
                      worktreeId
                        ? '可以新建文件，或切换到另一个工作区'
                        : worktreesLoading
                          ? '系统会自动列出这个项目的所有 worktree'
                          : worktreesError
                            ? '请在上方重新查找'
                            : '系统会自动发现 Git worktree；外部文件夹可从更多操作中添加'
                    }
                  />

                  {(file || openTabs.length > 0) && (
                    <>
                      <ResizeHandle
                        direction="vertical"
                        label="文件树与文件详情"
                        onResize={handleVerticalResize}
                        onDoubleClick={resetTreeBasis}
                      />
                      {file ? (
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
                          onToggleMarkdownRendered={() => setMarkdownRendered((previous) => !previous)}
                          onToggleHtmlPreview={() => setHtmlPreview((previous) => !previous)}
                          onToggleJsxPreview={() => setJsxPreview((previous) => !previous)}
                          onSave={handleSave}
                          onDirtyChange={setEditDirty}
                          pendingExternalSha={pendingExternalSha}
                          onApplyExternalChange={applyExternalChange}
                          onDismissExternalChange={dismissExternalChange}
                          revealInFinder={revealInFinder}
                          onFocusMode={() => setFocusedPane('file')}
                          restoreScrollTop={presentationLock ? workspaceScrollTop : undefined}
                          restoreKey={presentationLock ? viewportRestoreKey : undefined}
                          onScrollTopChange={presentationLock ? handleScrollTopChange : undefined}
                        />
                      ) : (
                        <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-cafe-secondary">
                          正在打开文档…
                        </div>
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
