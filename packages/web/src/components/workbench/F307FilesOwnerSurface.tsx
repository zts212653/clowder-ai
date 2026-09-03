'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createFileContextAttachment } from '@/components/chat-context-reference';
import { useConfirm } from '@/components/useConfirm';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { WorkspaceFilesSearch } from '@/components/workspace/WorkspaceFilesSearch';
import { type TreeCallbacks, WorkspaceTree } from '@/components/workspace/WorkspaceTree';
import { useFileManagement } from '@/hooks/useFileManagement';
import type { TreeNode, WorktreeEntry } from '@/hooks/useWorkspace';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { worktreeLabel } from '@/utils/worktree-label';
import { createFileSurface, createFilesSurface, resolveFilesTarget } from './real-surface-adapters';

function mergeSubtree(nodes: TreeNode[], targetPath: string, children: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath && node.type === 'directory') return { ...node, children };
    if (!node.children || !targetPath.startsWith(`${node.path}/`)) return node;
    return { ...node, children: mergeSubtree(node.children, targetPath, children) };
  });
}

function findNode(nodes: TreeNode[], path: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return undefined;
}

async function requestTree(worktreeId: string, path?: string): Promise<TreeNode[]> {
  const params = new URLSearchParams({ worktreeId, depth: '3' });
  if (path) params.set('path', path);
  const response = await apiFetch(`/api/workspace/tree?${params}`);
  if (!response.ok) throw new Error(`workspace tree owner unavailable: ${response.status}`);
  const payload = (await response.json()) as { tree?: TreeNode[] };
  return payload.tree ?? [];
}

async function requestWorktrees(projectPath: string): Promise<WorktreeEntry[]> {
  const params = new URLSearchParams();
  if (projectPath && projectPath !== 'default') params.set('repoRoot', projectPath);
  const query = params.toString();
  const response = await apiFetch(`/api/workspace/worktrees${query ? `?${query}` : ''}`);
  if (!response.ok) throw new Error(`worktree identity unavailable: ${response.status}`);
  const payload = (await response.json()) as { worktrees?: WorktreeEntry[] };
  if (!Array.isArray(payload.worktrees)) return [];
  return payload.worktrees;
}

function ownsWorktreeIdentity(entry: WorktreeEntry, worktreeId: string): boolean {
  return entry.id === worktreeId || entry.canonicalId === worktreeId;
}

export function F307FilesOwnerSurface({
  surface,
  onOpenSurface,
}: {
  surface: WorkspaceSurfaceDescriptor;
  onOpenSurface: (surface: WorkspaceSurfaceDescriptor) => void;
}) {
  const target = resolveFilesTarget(surface);
  const worktreeId = target?.worktreeId ?? null;
  const projectPath = useChatStore((state) => state.currentProjectPath);
  const currentThreadId = useChatStore((state) => state.currentThreadId);
  const setWorkspaceWorktreeId = useChatStore((state) => state.setWorkspaceWorktreeId);
  const setPendingChatInsert = useChatStore((state) => state.setPendingChatInsert);
  const confirm = useConfirm();
  const { createFile, createDir, deleteItem, renameItem, uploadFile } = useFileManagement(worktreeId);
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [identity, setIdentity] = useState<WorktreeEntry | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchRootTree = useCallback(async () => {
    if (!worktreeId) return;
    setLoading(true);
    setError(false);
    try {
      setTree(await requestTree(worktreeId));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [worktreeId]);

  const fetchSubtree = useCallback(
    async (path: string) => {
      if (!worktreeId) return;
      try {
        const children = await requestTree(worktreeId, path);
        setTree((current) => mergeSubtree(current, path, children));
      } catch {
        // The existing tree remains usable if one lazy subtree is unavailable.
      }
    },
    [worktreeId],
  );

  useEffect(() => {
    void fetchRootTree();
  }, [fetchRootTree]);

  useEffect(() => {
    if (!worktreeId) {
      setWorktrees([]);
      setIdentity(null);
      return;
    }
    let active = true;
    void requestWorktrees(projectPath)
      .then((nextWorktrees) => {
        if (!active) return;
        setWorktrees(nextWorktrees);
        setIdentity(nextWorktrees.find((entry) => ownsWorktreeIdentity(entry, worktreeId)) ?? null);
      })
      .catch(() => {
        if (!active) return;
        setWorktrees([]);
        setIdentity(null);
      });
    return () => {
      active = false;
    };
  }, [projectPath, worktreeId]);

  const selectWorktree = useCallback(
    (nextWorktreeId: string) => {
      const selected = worktrees.find((entry) => ownsWorktreeIdentity(entry, nextWorktreeId));
      if (!selected) return;
      if (selected.id === target?.worktreeId) return;
      setWorkspaceWorktreeId(selected.id);
      onOpenSurface(createFilesSurface(selected.id));
    },
    [onOpenSurface, setWorkspaceWorktreeId, target?.worktreeId, worktrees],
  );

  const openFile = useCallback(
    (path: string, scrollToLine?: number | null) => {
      if (!target) return;
      onOpenSurface(createFileSurface({ worktreeId: target.worktreeId, path, scrollToLine }));
    },
    [onOpenSurface, target],
  );

  const treeCallbacks = useMemo<TreeCallbacks>(
    () => ({
      onCreateFile: async (dirPath, name) => {
        const path = dirPath ? `${dirPath}/${name}` : name;
        const result = await createFile(path);
        if (result) {
          await fetchRootTree();
          openFile(path);
        }
        return !!result;
      },
      onCreateDir: async (dirPath, name) => {
        const path = dirPath ? `${dirPath}/${name}` : name;
        const result = await createDir(path);
        if (result) await fetchRootTree();
        return !!result;
      },
      onDelete: async (path) => {
        const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
        const accepted = await confirm({
          title: '删除确认',
          message: `删除 "${name}"？此操作不可撤销。`,
          variant: 'danger',
          confirmLabel: '删除',
        });
        if (!accepted) return false;
        const deleted = await deleteItem(path);
        if (deleted) await fetchRootTree();
        return deleted;
      },
      onRename: async (oldPath, newName) => {
        const dir = oldPath.includes('/') ? oldPath.slice(0, oldPath.lastIndexOf('/')) : '';
        const newPath = dir ? `${dir}/${newName}` : newName;
        const renamed = await renameItem(oldPath, newPath);
        if (renamed) {
          await fetchRootTree();
          openFile(newPath);
        }
        return renamed;
      },
      onUpload: async (dirPath, files) => {
        for (const file of Array.from(files)) {
          const path = dirPath ? `${dirPath}/${file.name}` : file.name;
          await uploadFile(path, file);
        }
        await fetchRootTree();
      },
    }),
    [confirm, createDir, createFile, deleteItem, fetchRootTree, openFile, renameItem, uploadFile],
  );

  const handleCite = useCallback(
    (path: string) => {
      if (!target) return;
      setPendingChatInsert({
        threadId: currentThreadId,
        text: '',
        contextAttachments: [
          createFileContextAttachment(path, target.worktreeId, {
            ...(identity?.branch ? { branch: identity.branch } : {}),
          }),
        ],
      });
    },
    [currentThreadId, identity?.branch, setPendingChatInsert, target],
  );

  if (!target) {
    return <div className="p-5 text-xs text-cafe-muted">Files descriptor 没有合法的 F063 worktree owner。</div>;
  }

  const rootLabel = identity?.root ?? target.worktreeId;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-[var(--console-panel-bg)]"
      data-testid="f307-files-owner-surface"
      data-owner-worktree={target.worktreeId}
    >
      <div
        className="flex-shrink-0 border-b border-cafe-subtle/40 px-3 py-2"
        data-testid="f307-files-worktree-identity"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <label className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0 text-cafe-interactive/55">工作区</span>
            <select
              value={identity?.id ?? target.worktreeId}
              onChange={(event) => selectWorktree(event.target.value)}
              disabled={worktrees.length === 0}
              className="min-w-0 flex-1 truncate rounded-md border border-cafe-subtle bg-cafe-surface px-2 py-1 font-semibold text-cafe-black"
              aria-label="当前工作区"
              data-testid="f307-files-worktree-select"
            >
              {worktrees.length === 0 ? (
                <option value={target.worktreeId}>{identity ? worktreeLabel(identity) : target.worktreeId}</option>
              ) : (
                worktrees.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {worktreeLabel(entry)}
                  </option>
                ))
              )}
            </select>
          </label>
          <span className="text-cafe-interactive/45">branch</span>
          <code className="max-w-[32%] truncate rounded bg-cafe-surface-sunken px-1.5 py-0.5 text-micro text-cafe-interactive">
            {identity?.branch ?? '读取中…'}
          </code>
          <span className="text-cafe-interactive/45">HEAD</span>
          <code
            className="max-w-[24%] truncate rounded bg-cafe-surface-sunken px-1.5 py-0.5 text-micro text-cafe-interactive"
            data-testid="f307-files-worktree-head"
          >
            {identity?.head ?? '读取中…'}
          </code>
        </div>
        <div className="mt-1 truncate font-mono text-micro text-cafe-interactive/50" title={rootLabel}>
          {rootLabel}
        </div>
      </div>
      <WorkspaceFilesSearch
        worktreeId={target.worktreeId}
        branch={identity?.branch}
        onOpen={(path, line) => openFile(path, line)}
      />
      {error && (
        <div className="border-b border-[var(--semantic-critical)]/30 bg-[var(--semantic-critical-surface)] px-3 py-2 text-xs text-conn-red-text">
          Failed to load file tree
        </div>
      )}
      <WorkspaceTree
        tree={tree}
        loading={loading}
        expandedPaths={expandedPaths}
        toggleExpand={(path) => {
          setExpandedPaths((current) => {
            const next = new Set(current);
            if (next.has(path)) {
              next.delete(path);
            } else {
              next.add(path);
              const node = findNode(tree, path);
              if (node?.type === 'directory' && node.children === undefined) void fetchSubtree(path);
            }
            return next;
          });
        }}
        onSelect={openFile}
        onCite={handleCite}
        selectedPath={null}
        hasFile={false}
        callbacks={treeCallbacks}
        emptyTitle="这个工作区还没有文件"
        emptyDescription="可以新建或上传文件，也可以从 Workspace Home 打开另一个工作区"
      />
    </div>
  );
}
