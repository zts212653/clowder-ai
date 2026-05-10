import { useCallback, useEffect, useRef, useState } from 'react';
import type { TreeNode } from '@/hooks/useWorkspace';
import { useChatStore } from '@/stores/chatStore';

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

export function useTreeNavigation(deps: {
  tree: TreeNode[];
  currentThreadId: string | null;
  fetchSubtree: (path: string) => Promise<void>;
}) {
  const { tree, currentThreadId, fetchSubtree } = deps;

  const storeRevealPath = useChatStore((s) => s.workspaceRevealPath);
  const setStoreRevealPath = useChatStore((s) => s.setWorkspaceRevealPath);

  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [pendingRevealPath, setPendingRevealPath] = useState<string | null>(null);

  useEffect(() => {
    if (!storeRevealPath) return;
    setPendingRevealPath(storeRevealPath);
    setStoreRevealPath(null);
  }, [storeRevealPath, setStoreRevealPath]);

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

  const toggleExpand = useCallback(
    (path: string) => {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
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

  const revealInTree = useCallback((filePath: string) => {
    setPendingRevealPath(filePath);
  }, []);

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
          needsFetch = true;
          break;
        }
      }
      return next;
    });
    if (!needsFetch) {
      setPendingRevealPath(null);
    }
  }, [pendingRevealPath, tree, fetchSubtree]);

  return {
    expandedPaths,
    setExpandedPaths,
    toggleExpand,
    pendingRevealPath,
    revealInTree,
  };
}
