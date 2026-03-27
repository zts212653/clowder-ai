'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFileManagement } from '@/hooks/useFileManagement';
import { usePersistedState } from '@/hooks/usePersistedState';
import type { TreeNode } from '@/hooks/useWorkspace';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useChatStore } from '@/stores/chatStore';
import { API_URL, apiFetch } from '@/utils/api-client';
import { MarkdownContent } from './MarkdownContent';
import { useConfirm } from './useConfirm';
import { BrowserPanel } from './workspace/BrowserPanel';
import { ChangesPanel } from './workspace/ChangesPanel';
import { CodeViewer } from './workspace/CodeViewer';
import { FileIcon } from './workspace/FileIcons';
import { GitPanel } from './workspace/GitPanel';
import { JsxPreview } from './workspace/JsxPreview';
import { KnowledgeFeed } from './workspace/KnowledgeFeed';
import { LinkedRootRemoveButton, LinkedRootsManager } from './workspace/LinkedRootsManager';
import { ResizeHandle } from './workspace/ResizeHandle';
import { SchedulePanel } from './workspace/SchedulePanel';
import { TerminalTab } from './workspace/TerminalTab';
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
      {dir && <div className="text-[10px] text-gray-400 truncate ml-5">{dir}</div>}
      {content && <div className="text-[10px] text-gray-500 truncate font-mono ml-5 mt-0.5">{highlighted}</div>}
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
  const restoreWorkspaceTabs = useChatStore((s) => s.restoreWorkspaceTabs);
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
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  /** Progressive reveal: store target path, expand ancestors as tree loads deeper. */
  const [pendingRevealPath, setPendingRevealPath] = useState<string | null>(null);

  useEffect(() => {
    if (!storeRevealPath) return;
    setPendingRevealPath(storeRevealPath);
    setViewMode('files');
    setStoreRevealPath(null);
  }, [storeRevealPath, setStoreRevealPath]);

  // G7-2: Per-thread workspace state — save/restore expandedPaths on thread switch
  const threadStateCache = useRef<Map<string, { expanded: Set<string>; tabs: string[]; openFile: string | null }>>(
    new Map(),
  );
  const prevThreadRef = useRef<string | null>(null);
  useEffect(() => {
    const prevThread = prevThreadRef.current;
    // Save previous thread's state
    if (prevThread && prevThread !== currentThreadId) {
      threadStateCache.current.set(prevThread, {
        expanded: new Set(expandedPaths),
        tabs: [...openTabs],
        openFile: openFilePath,
      });
    }
    // Restore current thread's state (atomic replace, not additive)
    if (currentThreadId && currentThreadId !== prevThread) {
      const cached = threadStateCache.current.get(currentThreadId);
      if (cached) {
        setExpandedPaths(cached.expanded);
        restoreWorkspaceTabs(cached.tabs, cached.openFile);
      } else {
        setExpandedPaths(new Set());
        restoreWorkspaceTabs([], null);
      }
      // Clear any in-flight reveal so it doesn't leak into the new thread
      setPendingRevealPath(null);
    }
    prevThreadRef.current = currentThreadId;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only trigger on thread change
  }, [currentThreadId, expandedPaths, openFilePath, openTabs, restoreWorkspaceTabs]);
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
  const [mdHasSelection, setMdHasSelection] = useState(false);
  const mdContainerRef = useRef<HTMLDivElement>(null);
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
      setEditMode(false);
    },
    [setOpenFile, setSearchResults],
  );

  const handleSearchSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (searchQuery.trim()) search(searchQuery.trim(), searchMode);
    },
    [searchQuery, searchMode, search],
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

  // Markdown rendered mode: detect native text selection for Add to Chat.
  // Deps include editMode so the listener re-binds after edit→rendered toggle (P1 fix).
  useEffect(() => {
    const container = mdContainerRef.current;
    if (!container) {
      setMdHasSelection(false);
      return;
    }
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        setMdHasSelection(false);
        return;
      }
      // Check both anchor and focus are inside the container (P2 fix: cross-boundary drag).
      if (!container.contains(sel.anchorNode) || !container.contains(sel.focusNode)) {
        setMdHasSelection(false);
        return;
      }
      setMdHasSelection(!!sel.toString().trim());
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [markdownRendered, openFilePath, editMode]);

  const handleMdAddToChat = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const container = mdContainerRef.current;
    if (!container || !container.contains(sel.anchorNode) || !container.contains(sel.focusNode)) return;
    const text = sel.toString().trim();
    if (!text || !openFilePath) return;
    const branch = currentWorktree?.branch;
    const suffix = branch ? ` (🌿 ${branch})` : '';
    const ref = `\`${openFilePath}\`${suffix}\n\`\`\`markdown\n${text}\n\`\`\``;
    setPendingChatInsert({ threadId: currentThreadId, text: ref });
  }, [openFilePath, currentWorktree, setPendingChatInsert, currentThreadId]);

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
                className="flex-1 text-[10px] border border-cocreator-light rounded-md px-2 py-1 bg-white/80 text-cafe-black focus:outline-none focus:border-cocreator-primary"
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
        <div className="flex items-center gap-1.5 bg-white/80 border border-cocreator-light rounded-lg px-2.5 py-1.5 focus-within:border-cocreator-primary focus-within:ring-1 focus-within:ring-cocreator-primary/20 transition-all">
          <SearchIcon />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
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
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white/50">
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
          onClick={() => setWorkspaceMode('knowledge')}
          className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-semibold transition-all ${
            workspaceMode === 'knowledge'
              ? 'bg-cocreator-primary/10 text-cocreator-primary border border-cocreator-primary/30'
              : 'text-cocreator-dark/40 hover:text-cocreator-dark/60'
          }`}
        >
          <span className="text-xs">✨</span> 知识
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
      </div>

      {/* Knowledge / Schedule / Dev mode routing */}
      {workspaceMode === 'knowledge' ? (
        <KnowledgeFeed />
      ) : workspaceMode === 'schedule' ? (
        <SchedulePanel />
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
          {error && <div className="px-3 py-2 text-xs text-red-600 bg-red-50/80 border-b border-red-100">{error}</div>}

          {/* F120: Port Discovery Toast — matches design Scene 2 */}
          {portDiscoveryToast && (
            <div className="mx-3 my-2 p-4 rounded-xl bg-white shadow-md border border-[#E8E7E5]">
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
            <BrowserPanel initialPort={previewPort} initialPath={previewPath} />
          ) : viewMode === 'terminal' ? (
            worktreeId ? (
              <TerminalTab worktreeId={worktreeId} />
            ) : (
              <div className="flex items-center justify-center h-full text-sm text-cocreator-dark/50">
                请先选择一个 Worktree
              </div>
            )
          ) : viewMode === 'git' ? (
            <GitPanel />
          ) : viewMode === 'changes' ? (
            <ChangesPanel worktreeId={worktreeId} basisPct={treeBasis} />
          ) : (
            <>
              {/* Search results — grouped when in 'all' mode */}
              {searchResults.length > 0 &&
                (() => {
                  const fileHits = searchResults.filter((r) => r.matchType === 'filename');
                  const contentHits = searchResults.filter((r) => r.matchType === 'content');
                  const isGrouped = fileHits.length > 0 || contentHits.length > 0;
                  return (
                    <div className="border-b border-cocreator-light/40 max-h-64 overflow-y-auto">
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

              {/* Vertical resize handle + File viewer */}
              {(file || openTabs.length > 0) && (
                <>
                  <ResizeHandle direction="vertical" onResize={handleVerticalResize} onDoubleClick={resetTreeBasis} />
                  <div className="flex-1 flex flex-col min-h-0 animate-fade-in">
                    {/* Tab bar */}
                    {openTabs.length > 0 && (
                      <div className="flex bg-[#1E1E24] border-b border-[#2a2a32] overflow-x-auto scrollbar-none">
                        {openTabs.map((tab) => (
                          <button
                            key={tab}
                            type="button"
                            onClick={() => setOpenFile(tab)}
                            className={`group flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono border-r border-[#2a2a32] flex-shrink-0 transition-colors ${
                              tab === openFilePath
                                ? 'bg-[#2a2a32] text-gray-200'
                                : 'text-gray-500 hover:text-gray-300 hover:bg-[#252530]'
                            }`}
                            title={tab}
                          >
                            <FileIcon name={tab} />
                            <span className="truncate max-w-[120px]">{tab.split('/').pop()}</span>
                            <span
                              role="button"
                              tabIndex={0}
                              onClick={(e) => {
                                e.stopPropagation();
                                closeTab(tab);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.stopPropagation();
                                  closeTab(tab);
                                }
                              }}
                              className="ml-0.5 w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-white/10 transition-opacity text-gray-500 hover:text-gray-300"
                              title="关闭"
                            >
                              ×
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                    {file && (
                      <>
                        <div className="px-3 py-1 bg-[#1E1E24] flex items-center justify-between">
                          <div className="flex items-center gap-2 min-w-0">
                            {file.size > 0 && (
                              <span className="text-[9px] text-gray-500 font-mono flex-shrink-0">
                                {file.size < 1024 ? `${file.size}B` : `${Math.round(file.size / 1024)}KB`}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {isMarkdown && !editMode && (
                              <button
                                type="button"
                                onClick={() => setMarkdownRendered((p) => !p)}
                                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                                  markdownRendered
                                    ? 'bg-cocreator-primary/80 text-white hover:bg-cocreator-primary'
                                    : 'text-gray-500 hover:text-gray-300 hover:bg-white/10'
                                }`}
                                title={markdownRendered ? '切换到源码' : '切换到渲染'}
                              >
                                {markdownRendered ? 'Rendered' : 'Raw'}
                              </button>
                            )}
                            {isHtml && !editMode && (
                              <button
                                type="button"
                                onClick={() => setHtmlPreview((p) => !p)}
                                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                                  htmlPreview
                                    ? 'bg-cocreator-primary/80 text-white hover:bg-cocreator-primary'
                                    : 'text-gray-500 hover:text-gray-300 hover:bg-white/10'
                                }`}
                                title={htmlPreview ? '切换到源码' : '预览 HTML'}
                              >
                                {htmlPreview ? 'Preview' : 'Code'}
                              </button>
                            )}
                            {isJsx && !editMode && (
                              <button
                                type="button"
                                onClick={() => setJsxPreview((p) => !p)}
                                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                                  jsxPreview
                                    ? 'bg-blue-600/80 text-white hover:bg-blue-500'
                                    : 'text-gray-500 hover:text-gray-300 hover:bg-white/10'
                                }`}
                                title={jsxPreview ? '切换到源码' : '预览 JSX/TSX'}
                              >
                                {jsxPreview ? 'Preview' : 'Code'}
                              </button>
                            )}

                            {file?.content != null && (
                              <button
                                type="button"
                                onClick={() => {
                                  void navigator.clipboard.writeText(file.content);
                                }}
                                className="px-2 py-0.5 rounded text-[10px] font-medium text-gray-500 hover:text-gray-300 hover:bg-white/10 transition-colors"
                                title={file.truncated ? '复制已加载内容（文件已截断，非完整全文）' : '复制文件全文'}
                              >
                                {file.truncated ? 'Copy…' : 'Copy'}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                if (!openFilePath) return;
                                const abs = currentWorktree ? `${currentWorktree.root}/${openFilePath}` : openFilePath;
                                void navigator.clipboard.writeText(abs);
                              }}
                              className="px-2 py-0.5 rounded text-[10px] font-medium text-gray-500 hover:text-gray-300 hover:bg-white/10 transition-colors"
                              title="复制绝对路径"
                            >
                              Path
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (openFilePath) void revealInFinder(openFilePath);
                              }}
                              className="px-2 py-0.5 rounded text-[10px] font-medium text-gray-500 hover:text-gray-300 hover:bg-white/10 transition-colors"
                              title="在 Finder 中显示"
                            >
                              Finder
                            </button>
                            {canEdit && (
                              <button
                                type="button"
                                onClick={handleToggleEdit}
                                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                                  editMode
                                    ? 'bg-green-600/80 text-white hover:bg-green-500'
                                    : 'text-gray-500 hover:text-gray-300 hover:bg-white/10'
                                }`}
                                title={editMode ? '退出编辑' : '编辑文件'}
                              >
                                {editMode ? '编辑中' : '编辑'}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                if (openFilePath) closeTab(openFilePath);
                                setEditMode(false);
                              }}
                              className="w-5 h-5 flex items-center justify-center rounded text-gray-500 hover:text-gray-300 hover:bg-white/10 transition-colors"
                              title="关闭标签页"
                            >
                              <CloseIcon />
                            </button>
                          </div>
                        </div>
                        {saveError && (
                          <div className="px-3 py-1.5 text-[10px] text-red-400 bg-red-900/20 border-b border-red-900/30">
                            {saveError}
                          </div>
                        )}
                        {file.binary ? (
                          file.mime.startsWith('image/') ? (
                            <div className="flex-1 flex items-center justify-center bg-[#1E1E24] p-4 overflow-auto">
                              <img
                                src={`${API_URL}/api/workspace/file/raw?worktreeId=${encodeURIComponent(worktreeId ?? '')}&path=${encodeURIComponent(file.path)}`}
                                alt={file.path}
                                className="max-w-full max-h-full object-contain rounded"
                              />
                            </div>
                          ) : file.mime.startsWith('audio/') ? (
                            <div className="flex-1 flex flex-col items-center justify-center bg-[#1E1E24] p-6 gap-3">
                              <span className="text-3xl">🎵</span>
                              <audio
                                controls
                                src={`${API_URL}/api/workspace/file/raw?worktreeId=${encodeURIComponent(worktreeId ?? '')}&path=${encodeURIComponent(file.path)}`}
                                className="w-full max-w-md"
                              >
                                浏览器不支持音频播放
                              </audio>
                              <p className="text-[10px] text-gray-500">
                                {file.mime} · {Math.round(file.size / 1024)}KB
                              </p>
                            </div>
                          ) : file.mime.startsWith('video/') ? (
                            <div className="flex-1 flex items-center justify-center bg-[#1E1E24] p-4 overflow-auto">
                              <video
                                controls
                                src={`${API_URL}/api/workspace/file/raw?worktreeId=${encodeURIComponent(worktreeId ?? '')}&path=${encodeURIComponent(file.path)}`}
                                className="max-w-full max-h-full rounded"
                              >
                                浏览器不支持视频播放
                              </video>
                            </div>
                          ) : (
                            <div className="flex flex-col items-center justify-center py-8 bg-[#1E1E24] text-gray-500 text-xs">
                              <span className="text-2xl mb-2">📄</span>
                              <p>二进制文件</p>
                              <p className="text-[10px] mt-1">
                                {file.mime} · {Math.round(file.size / 1024)}KB
                              </p>
                              <button
                                type="button"
                                onClick={() => void revealInFinder(file.path)}
                                className="mt-2 px-3 py-1 rounded bg-cocreator-light/20 text-cocreator-dark/60 hover:bg-cocreator-light/40 transition-colors text-[10px]"
                              >
                                在 Finder 中打开
                              </button>
                            </div>
                          )
                        ) : isMarkdown && markdownRendered && !editMode ? (
                          <div className="relative flex-1 overflow-auto bg-cafe-white p-4" ref={mdContainerRef}>
                            <MarkdownContent
                              content={file.content}
                              disableCommandPrefix
                              basePath={openFilePath ? openFilePath.split('/').slice(0, -1).join('/') : undefined}
                            />
                            {mdHasSelection && (
                              <button
                                type="button"
                                onClick={handleMdAddToChat}
                                className="absolute top-2 right-3 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-cocreator-primary text-white text-[11px] font-medium shadow-lg hover:bg-cocreator-dark transition-colors z-10 animate-fade-in"
                                title="引用到聊天"
                              >
                                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                                  <path d="M1.5 2.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H5L2.5 11.5V9h-1a1 1 0 0 1-1-1V2.5Z" />
                                  <path d="M13.5 5v4a1 1 0 0 1-1 1H12v2.5L9.5 10H7a1 1 0 0 1-1-1" opacity="0.5" />
                                </svg>
                                Add to chat
                              </button>
                            )}
                          </div>
                        ) : isHtml && htmlPreview && !editMode ? (
                          <div className="flex-1 min-h-0 flex flex-col">
                            {/* Sandboxed preview: relative asset paths (images, CSS, JS) cannot resolve
                    because srcDoc loads as about:srcdoc. A full asset proxy is future scope (P2D). */}
                            <div className="px-2 py-1 bg-amber-900/20 text-amber-400 text-[10px] border-b border-amber-900/30 flex-shrink-0">
                              预览模式 — 相对资源路径（图片/CSS/JS）可能无法加载
                            </div>
                            <div className="flex-1 min-h-0 bg-white">
                              <iframe
                                srcDoc={file.content}
                                sandbox="allow-scripts"
                                title="HTML Preview"
                                className="w-full h-full border-0"
                              />
                            </div>
                          </div>
                        ) : isJsx && jsxPreview && !editMode ? (
                          <JsxPreview code={file.content} filePath={openFilePath!} worktreeId={worktreeId} />
                        ) : (
                          <CodeViewer
                            content={file.content}
                            mime={file.mime}
                            path={file.path}
                            scrollToLine={scrollToLine}
                            editable={editMode}
                            onSave={handleSave}
                            branch={currentWorktree?.branch}
                          />
                        )}
                        {file.truncated && (
                          <div className="px-3 py-1.5 text-[10px] text-amber-400 bg-[#1E1E24] border-t border-amber-900/30">
                            文件已截断 (超过 1MB)
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </>
              )}
            </> /* end viewMode=files */
          )}
        </>
      )}
    </aside>
  );
}
