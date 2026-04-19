'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFileManagement } from '@/hooks/useFileManagement';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { usePersistedState } from '@/hooks/usePersistedState';
import type { TreeNode } from '@/hooks/useWorkspace';
import { useWorkspace } from '@/hooks/useWorkspace';
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
        <mark className="bg-cocreator-light text-cocreator-dark rounded px-0.5">
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
      className="w-full text-left px-3 py-1.5 hover:bg-cocreator-bg/60 transition-colors group"
    >
      <div className="flex items-center gap-1.5">
        <FileIcon name={fileName} />
        <span className="text-xs font-medium text-cafe-black truncate">{fileName}</span>
        {line > 0 && <span className="text-[10px] text-cocreator-dark/50 font-mono">:{line}</span>}
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
  <svg
    className="w-3.5 h-3.5 text-cocreator-dark/40 flex-shrink-0"
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

const MenuIcon = () => (
  <svg
    className="w-4 h-4 text-cocreator-primary flex-shrink-0"
    viewBox="0 0 20 20"
    fill="currentColor"
    aria-hidden="true"
  >
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
  const editToken = useChatStore((s) => s.workspaceEditToken);
  const editTokenExpiry = useChatStore((s) => s.workspaceEditTokenExpiry);
  const setEditToken = useChatStore((s) => s.setWorkspaceEditToken);

  const pendingPreviewAutoOpen = useChatStore((s) => s.pendingPreviewAutoOpen);
  const consumePreviewAutoOpen = useChatStore((s) => s.consumePreviewAutoOpen);
  const storeRevealPath = useChatStore((s) => s.workspaceRevealPath);
  const setStoreRevealPath = useChatStore((s) => s.setWorkspaceRevealPath);
  const { createFile, createDir, deleteItem, renameItem, uploadFile } = useFileManagement();

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
  }, [storeRevealPath, setStoreRevealPath]);

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
  // F168: Auto-switch workspace mode based on thread's preferredWorkspaceMode
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

  const [editMode, setEditMode] = useState(false);
  const [markdownRendered, setMarkdownRendered] = useState(true);
  const [htmlPreview, setHtmlPreview] = useState(false);
  const [jsxPreview, setJsxPreview] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
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
      setSearchResults([]);
      setDidSearch(false);
      setEditMode(false);
    },
    [setOpenFile, setSearchResults],
  );

  const handleSearchSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmedQuery = searchQuery.trim();
      if (!trimmedQuery) {
        setDidSearch(false);
        setSearchResults([]);
        return;
      }
      setDidSearch(true);
      void search(trimmedQuery, searchMode);
    },
    [searchQuery, searchMode, search, setSearchResults],
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
      setSearchResults([]);
      setDidSearch(false);
      setEditMode(false);
      revealInTree(path);
    },
    [setOpenFile, setSearchResults, revealInTree],
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

  const isTokenValid = editToken && editTokenExpiry && editTokenExpiry > Date.now();
  const canEdit = file && !file.binary && !file.truncated;
  const isMarkdown = !!(openFilePath && (openFilePath.endsWith('.md') || openFilePath.endsWith('.mdx')));
  const isHtml = !!(openFilePath && /\.html?$/i.test(openFilePath));
  const isJsx = !!(openFilePath && /\.[jt]sx$/i.test(openFilePath));

  const handleToggleEdit = useCallback(async () => {
    // If already editing with a valid token, toggle off
    if (editMode && isTokenValid) {
      setEditMode(false);
      return;
    }
    if (!worktreeId) return;
    setSaveError(null);

    // Get or refresh token (also handles expired-token-while-editing case)
    if (!isTokenValid) {
      try {
        const res = await apiFetch('/api/workspace/edit-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktreeId }),
        });
        if (!res.ok) {
          setSaveError('无法获取编辑权限');
          return;
        }
        const data = await res.json();
        setEditToken(data.token, data.expiresIn);
      } catch {
        setSaveError('网络错误');
        return;
      }
    }
    setEditMode(true);
  }, [editMode, worktreeId, isTokenValid, setEditToken]);

  const handleSave = useCallback(
    async (newContent: string) => {
      if (!worktreeId || !openFilePath || !file) return;
      if (!editToken) {
        setSaveError('编辑会话过期，请点击「编辑」按钮刷新权限后重试保存');
        return;
      }
      setSaveError(null);
      try {
        const res = await apiFetch('/api/workspace/file', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            worktreeId,
            path: openFilePath,
            content: newContent,
            baseSha256: file.sha256,
            editSessionToken: editToken,
          }),
        });
        if (res.status === 409) {
          setSaveError('冲突：文件已被修改，请重新加载');
          return;
        }
        if (res.status === 401) {
          setEditToken(null);
          // Keep editMode=true so unsaved edits aren't lost.
          // User can click the edit toggle to re-acquire a token and retry.
          setSaveError('编辑会话过期，请点击「编辑」按钮刷新权限后重试保存');
          return;
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: 'Unknown error' }));
          setSaveError(data.error || '保存失败');
          return;
        }
        // Re-fetch file to get new content + sha256
        if (openFilePath) await fetchFile(openFilePath);
      } catch {
        setSaveError('网络错误');
      }
    },
    [worktreeId, openFilePath, file, editToken, setEditToken, fetchFile],
  );

  return (
    <aside
      ref={panelRef}
      className="hidden lg:flex flex-1 min-w-0 border-l border-cocreator-light bg-cafe-white/95 flex-col overflow-hidden animate-slide-in-right"
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
            <div className="flex items-center justify-center h-full text-sm text-cocreator-dark/50">
              请先选择一个 Worktree
            </div>
          )}
        </WorkspaceFocusShell>
      ) : (
        <>
          {/* Header */}
          <div className="px-3 py-2.5 border-b border-cocreator-light flex items-center justify-between bg-cocreator-bg/50">
            <div className="flex items-center gap-2 min-w-0">
              <MenuIcon />
              <span className="text-sm font-semibold text-cafe-black">Workspace</span>
            </div>
            <button
              type="button"
              onClick={() => setRightPanelMode('status')}
              className="w-6 h-6 flex items-center justify-center rounded-md text-cocreator-dark/40 hover:text-cocreator-dark hover:bg-cocreator-light/60 transition-colors"
              title="切换到状态面板"
            >
              <CloseIcon />
            </button>
          </div>

          {/* Worktree indicator */}
          {currentWorktree && (
            <div className="px-3 py-2 border-b border-cocreator-light/60 bg-cocreator-bg/30">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
                <span className="text-xs font-medium text-cafe-black truncate">{currentWorktree.branch}</span>
                <span className="text-[10px] font-mono text-cocreator-dark/50">{currentWorktree.head}</span>
              </div>
              {worktrees.length > 1 && (
                <div className="flex items-center gap-1 mt-1.5">
                  <select
                    value={worktreeId ?? ''}
                    onChange={(e) => setWorktreeId(e.target.value || null)}
                    className="flex-1 text-[10px] border border-cocreator-light rounded-md px-2 py-1 bg-cafe-surface/80 text-cafe-black focus:outline-none focus:border-cocreator-primary"
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
          <form onSubmit={handleSearchSubmit} className="px-3 py-2 border-b border-cocreator-light/40">
            <div className="flex items-center gap-1.5 bg-cafe-surface/80 border border-cocreator-light rounded-lg px-2.5 py-1.5 focus-within:border-cocreator-primary focus-within:ring-1 focus-within:ring-cocreator-primary/20 transition-all">
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
                className="flex-1 text-xs bg-transparent text-cafe-black placeholder:text-cocreator-dark/30 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setSearchMode((m) => (m === 'all' ? 'filename' : m === 'filename' ? 'content' : 'all'))}
                className={`text-[10px] px-1.5 py-0.5 rounded-md font-medium transition-colors ${
                  searchMode === 'all'
                    ? 'bg-cocreator-primary/15 text-cocreator-primary'
                    : searchMode === 'filename'
                      ? 'bg-cocreator-light text-cocreator-dark'
                      : 'text-cocreator-dark/40 hover:text-cocreator-dark/60'
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
                  ? 'bg-cocreator-bg text-cocreator-dark border border-cocreator-light/60'
                  : 'text-cocreator-dark/40 hover:text-cocreator-dark/60'
              }`}
            >
              <span className="text-xs">&lt;/&gt;</span> 开发
            </button>
            <button
              type="button"
              onClick={() => setWorkspaceMode('recall')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-semibold transition-all ${
                workspaceMode === 'recall'
                  ? 'bg-cocreator-primary/10 text-cocreator-primary border border-cocreator-primary/30'
                  : 'text-cocreator-dark/40 hover:text-cocreator-dark/60'
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
                  ? 'bg-cocreator-bg text-cocreator-dark border border-cocreator-light/60'
                  : 'text-cocreator-dark/40 hover:text-cocreator-dark/60'
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
                  ? 'bg-cocreator-bg text-cocreator-dark border border-cocreator-light/60'
                  : 'text-cocreator-dark/40 hover:text-cocreator-dark/60'
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
                  ? 'bg-cocreator-bg text-cocreator-dark border border-cocreator-light/60'
                  : 'text-cocreator-dark/40 hover:text-cocreator-dark/60'
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
            <CommunityPanel />
          ) : (
            <>
              {/* Files / Changes toggle */}
              <div className="flex border-b border-cocreator-light/40">
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
                          ? 'text-cocreator-primary border-b-2 border-cocreator-primary'
                          : 'text-cocreator-dark/40 hover:text-cocreator-dark/60'
                      }`}
                    >
                      {labels[mode]}
                    </button>
                  );
                })}
              </div>

              {/* Error */}
              {error && (
                <div className="px-3 py-2 text-xs text-red-600 bg-red-50/80 border-b border-red-100">{error}</div>
              )}

              {/* F120: Port Discovery Toast — matches design Scene 2 */}
              {portDiscoveryToast && (
                <div className="mx-3 my-2 p-4 rounded-xl bg-cafe-surface shadow-md border border-[#E8E7E5]">
                  <div className="flex items-start justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[#E29578] text-base">◉</span>
                      <span className="text-sm font-semibold text-[#1A1918]">Dev Server Detected</span>
                    </div>
                    <button
                      type="button"
                      className="text-[#9C9B99] hover:text-[#5a4a42] text-xs"
                      onClick={() => setPortDiscoveryToast(null)}
                    >
                      ✕
                    </button>
                  </div>
                  <p className="text-xs text-[#6D6C6A] ml-6 mb-3">
                    localhost:{portDiscoveryToast.port} is now listening
                    {portDiscoveryToast.framework && portDiscoveryToast.framework !== 'unknown'
                      ? ` (${portDiscoveryToast.framework})`
                      : ''}
                  </p>
                  <div className="flex items-center gap-2 ml-6">
                    <button
                      type="button"
                      className="px-3 py-1.5 rounded-md bg-[#E29578] text-white text-xs font-medium hover:bg-[#d4856a] transition-colors"
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
                      className="px-3 py-1.5 text-xs text-[#5a4a42]/70 hover:text-[#5a4a42]"
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
                    <div className="flex items-center justify-center h-full text-sm text-cocreator-dark/50">
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
                    <div className="border-b border-cocreator-light/40 px-3 py-3 text-xs text-cocreator-dark/70 flex items-center gap-2">
                      <span className="inline-block w-3 h-3 border-2 border-cocreator-primary border-t-transparent rounded-full animate-spin" />
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
                        <div className="border-b border-cocreator-light/40 max-h-64 overflow-y-auto">
                          {searchResults.length > 0 ? (
                            <>
                              {isGrouped && fileHits.length > 0 && (
                                <>
                                  <div className="px-3 py-1.5 text-[10px] text-cocreator-dark/50 font-semibold uppercase tracking-wider sticky top-0 bg-cafe-white/95 backdrop-blur-sm">
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
                                  <div className="px-3 py-1.5 text-[10px] text-cocreator-dark/50 font-semibold uppercase tracking-wider sticky top-0 bg-cafe-white/95 backdrop-blur-sm">
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
                                  <div className="px-3 py-1.5 text-[10px] text-cocreator-dark/50 font-semibold uppercase tracking-wider sticky top-0 bg-cafe-white/95 backdrop-blur-sm">
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
                            <div className="px-3 py-3 text-xs text-cocreator-dark/70">
                              <div className="font-medium text-cafe-black">
                                未在 {currentWorktree?.branch ?? '当前工作区'} 中找到 “{searchQuery.trim()}”
                              </div>
                              <div className="mt-1 text-[11px] text-cocreator-dark/55">
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
