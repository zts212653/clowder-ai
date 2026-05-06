'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { API_URL, apiFetch } from '@/utils/api-client';

export interface WorktreeEntry {
  id: string;
  root: string;
  branch: string;
  head: string;
}

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: TreeNode[];
}

/** Recursively merge lazy-loaded subtree children into the existing tree */
function mergeSubtree(nodes: TreeNode[], targetPath: string, children: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath && node.type === 'directory') {
      return { ...node, children };
    }
    if (node.children && targetPath.startsWith(`${node.path}/`)) {
      return { ...node, children: mergeSubtree(node.children, targetPath, children) };
    }
    return node;
  });
}

export interface FileData {
  path: string;
  content: string;
  sha256: string;
  size: number;
  mime: string;
  truncated: boolean;
  binary?: boolean;
}

export interface SearchResult {
  path: string;
  line: number;
  content: string;
  contextBefore: string;
  contextAfter: string;
  /** Which search mode produced this result (used by 'all' mode for grouping) */
  matchType?: 'filename' | 'content';
}

export function useWorkspace() {
  const worktreeId = useChatStore((s) => s.workspaceWorktreeId);
  const openFilePath = useChatStore((s) => s.workspaceOpenFilePath);
  const setWorktreeId = useChatStore((s) => s.setWorkspaceWorktreeId);
  const projectPath = useChatStore((s) => s.currentProjectPath);

  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [file, setFile] = useState<FileData | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch worktrees — re-fetches when project changes
  const fetchWorktrees = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (projectPath && projectPath !== 'default') {
        params.set('repoRoot', projectPath);
      }
      const qs = params.toString();
      const res = await apiFetch(`/api/workspace/worktrees${qs ? `?${qs}` : ''}`);
      if (res.ok) {
        const data = await res.json();
        const newList: typeof worktrees = data.worktrees ?? [];
        setWorktrees(newList);
        // Auto-select first worktree if none selected or current was removed
        const currentStillExists = worktreeId && newList.some((w: { id: string }) => w.id === worktreeId);
        if (!currentStillExists && newList.length > 0) {
          setWorktreeId(newList[0].id);
        }
      }
    } catch {
      /* ignore */
    }
  }, [worktreeId, setWorktreeId, projectPath]);

  useEffect(() => {
    fetchWorktrees();
  }, [fetchWorktrees]);

  // Fetch tree when worktree changes
  const fetchTree = useCallback(
    async (subpath?: string) => {
      if (!worktreeId) return;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ worktreeId, depth: '3' });
        if (subpath) params.set('path', subpath);
        const res = await apiFetch(`/api/workspace/tree?${params}`);
        if (res.ok) {
          const data = await res.json();
          setTree(data.tree ?? []);
        } else {
          setError('Failed to load file tree');
        }
      } catch {
        setError('Failed to load file tree');
      } finally {
        setLoading(false);
      }
    },
    [worktreeId],
  );

  useEffect(() => {
    if (worktreeId) fetchTree();
  }, [worktreeId, fetchTree]);

  // Lazy-load subtree for a directory at max depth (children === undefined)
  const fetchSubtree = useCallback(
    async (dirPath: string) => {
      if (!worktreeId) return;
      try {
        const params = new URLSearchParams({ worktreeId, path: dirPath, depth: '3' });
        const res = await apiFetch(`/api/workspace/tree?${params}`);
        if (!res.ok) return;
        const data = await res.json();
        const subtreeChildren: TreeNode[] = data.tree ?? [];
        // Merge subtree into existing tree
        setTree((prev) => mergeSubtree(prev, dirPath, subtreeChildren));
      } catch {
        /* ignore */
      }
    },
    [worktreeId],
  );

  // Fetch file content
  const fetchFile = useCallback(
    async (path: string) => {
      if (!worktreeId) return;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ worktreeId, path });
        const res = await apiFetch(`/api/workspace/file?${params}`);
        if (res.ok) {
          const data = await res.json();
          setFile(data);
        } else {
          const data = await res.json().catch(() => ({ error: 'Unknown error' }));
          setError(data.error ?? 'Failed to load file');
        }
      } catch {
        setError('Failed to load file');
      } finally {
        setLoading(false);
      }
    },
    [worktreeId],
  );

  // Load file when openFilePath changes
  useEffect(() => {
    if (openFilePath) fetchFile(openFilePath);
    else setFile(null);
  }, [openFilePath, fetchFile]);

  // File-change watcher: auto-reload when file is modified externally
  const [pendingExternalSha, setPendingExternalSha] = useState<string | null>(null);
  const editDirtyRef = useRef(false);
  const fileShaRef = useRef<string | null>(null);

  useEffect(() => {
    fileShaRef.current = file?.sha256 ?? null;
  }, [file?.sha256]);

  const setEditDirty = useCallback(
    (dirty: boolean) => {
      editDirtyRef.current = dirty;
      if (!dirty && pendingExternalSha) {
        setPendingExternalSha(null);
        if (openFilePath) fetchFile(openFilePath);
      }
    },
    [pendingExternalSha, openFilePath, fetchFile],
  );

  const applyExternalChange = useCallback(() => {
    setPendingExternalSha(null);
    if (openFilePath) fetchFile(openFilePath);
  }, [openFilePath, fetchFile]);

  const dismissExternalChange = useCallback(() => {
    setPendingExternalSha(null);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on file switch
  useEffect(() => {
    setPendingExternalSha(null);
  }, [openFilePath]);

  useEffect(() => {
    if (!worktreeId || !openFilePath) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    import('socket.io-client').then(({ io }) => {
      if (cancelled) return;
      const apiUrl = new URL(API_URL);
      const socket = io(`${apiUrl.protocol}//${apiUrl.host}`, {
        transports: ['websocket'],
        forceNew: true,
      });

      socket.on('connect', () => {
        socket.emit('workspace:watch-file', {
          worktreeId,
          path: openFilePath,
          sha256: fileShaRef.current,
        });
      });

      socket.on('workspace:file-changed', (data: { worktreeId: string; path: string; sha256: string }) => {
        if (data.path !== openFilePath || data.worktreeId !== worktreeId) return;
        if (data.sha256 === fileShaRef.current) return;
        if (editDirtyRef.current) {
          setPendingExternalSha(data.sha256);
        } else {
          fetchFile(openFilePath);
        }
      });

      cleanup = () => {
        socket.emit('workspace:unwatch-file');
        socket.disconnect();
      };
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [worktreeId, openFilePath, fetchFile]);

  // Single-mode search helper (filename or content)
  const searchSingle = useCallback(
    async (query: string, type: 'content' | 'filename'): Promise<SearchResult[]> => {
      const res = await apiFetch('/api/workspace/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worktreeId, query, type }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to search workspace' }));
        throw new Error(data.error ?? 'Failed to search workspace');
      }
      const data = await res.json();
      return (data.results ?? []) as SearchResult[];
    },
    [worktreeId],
  );

  // Search — supports 'content', 'filename', or 'all' (fires both in parallel)
  const search = useCallback(
    async (query: string, type: 'content' | 'filename' | 'all' = 'content') => {
      if (!worktreeId || !query.trim()) return;
      setSearchLoading(true);
      setError(null);
      try {
        if (type === 'all') {
          const [fileResults, contentResults] = await Promise.all([
            searchSingle(query, 'filename'),
            searchSingle(query, 'content'),
          ]);
          // Tag each result with its match type for grouped rendering
          const tagged: SearchResult[] = [
            ...fileResults.map((r) => ({ ...r, matchType: 'filename' as const })),
            ...contentResults.map((r) => ({ ...r, matchType: 'content' as const })),
          ];
          setSearchResults(tagged);
        } else {
          const results = await searchSingle(query, type);
          setSearchResults(results);
        }
      } catch {
        setSearchResults([]);
        setError('Failed to search workspace');
      } finally {
        setSearchLoading(false);
      }
    },
    [worktreeId, searchSingle],
  );

  // Reveal file in system file manager (Finder/Explorer)
  const revealInFinder = useCallback(
    async (path: string) => {
      if (!worktreeId) return;
      try {
        await apiFetch('/api/workspace/reveal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktreeId, path }),
        });
      } catch {
        /* ignore */
      }
    },
    [worktreeId],
  );

  return {
    worktrees,
    worktreeId,
    tree,
    file,
    searchResults,
    loading,
    searchLoading,
    error,
    pendingExternalSha,
    fetchWorktrees,
    fetchTree,
    fetchSubtree,
    fetchFile,
    search,
    setSearchResults,
    revealInFinder,
    setEditDirty,
    applyExternalChange,
    dismissExternalChange,
  };
}
