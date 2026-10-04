'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createFileContextAttachment } from '@/components/chat-context-reference';
import { useConfirm } from '@/components/useConfirm';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { LinkedRootRemoveButton } from '@/components/workspace/LinkedRootsManager';
import { WorkspaceFilesSearch } from '@/components/workspace/WorkspaceFilesSearch';
import { type TreeCallbacks, WorkspaceTree } from '@/components/workspace/WorkspaceTree';
import { useFileManagement } from '@/hooks/useFileManagement';
import type { TreeNode } from '@/hooks/useWorkspace';
import { useChatStore } from '@/stores/chatStore';
import { worktreeHeadLabel, worktreeLabel } from '@/utils/worktree-label';
import { F307FilesRevealStatus } from './F307FilesRevealStatus';
import { findNode, mergeSubtree, requestTree, type SubtreeLoad, TreeRequestError, useFilesReveal } from './files-tree';
import { createFileSurface, createFilesSurface, resolveFilesTarget } from './real-surface-adapters';
import {
  IDENTITY_PLACEHOLDER,
  IDENTITY_STATUS,
  matchesWorktreeIdentity,
  useFilesWorktreeIdentity,
} from './useFilesWorktreeIdentity';

export function F307FilesOwnerSurface({
  surface,
  onOpenSurface,
  onReturnToNavigationOrigin,
}: {
  surface: WorkspaceSurfaceDescriptor;
  onOpenSurface: (surface: WorkspaceSurfaceDescriptor) => void;
  /** Present when this tree was opened from an entry (e.g. Settings) the person can go back to. */
  onReturnToNavigationOrigin?: () => void;
}) {
  const target = resolveFilesTarget(surface);
  const worktreeId = target?.worktreeId ?? null;
  const projectPath = useChatStore((state) => state.currentProjectPath);
  const currentThreadId = useChatStore((state) => state.currentThreadId);
  const setWorkspaceWorktreeId = useChatStore((state) => state.setWorkspaceWorktreeId);
  const setPendingChatInsert = useChatStore((state) => state.setPendingChatInsert);
  const confirm = useConfirm();
  const { createFile, createDir, deleteItem, renameItem, uploadFile } = useFileManagement(worktreeId);
  // Identity is read through the coordinate that minted this id, never through whichever chat is current.
  const identityRoot = target?.repoRoot ?? projectPath;
  // An id minted under an explicit root is that exact entry; aliases only serve pre-coordinate descriptors.
  const exactIdentity = Boolean(target?.repoRoot);
  const {
    worktrees,
    identity: identityState,
    reread: rereadIdentity,
  } = useFilesWorktreeIdentity(worktreeId, identityRoot, exactIdentity);
  const identity = identityState.state === 'known' ? identityState.entry : null;
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
    async (path: string): Promise<SubtreeLoad> => {
      if (!worktreeId) return { ok: false, status: null };
      try {
        const children = await requestTree(worktreeId, path);
        // '' is the worktree root: a fresh root listing replaces the tree instead of merging under a node.
        setTree((current) => (path ? mergeSubtree(current, path, children) : children));
        return { ok: true };
      } catch (cause) {
        // The existing tree remains usable if one lazy subtree is unavailable; a reveal reports why.
        return { ok: false, status: cause instanceof TreeRequestError ? cause.status : null };
      }
    },
    [worktreeId],
  );

  useEffect(() => {
    void fetchRootTree();
  }, [fetchRootTree]);

  const expandRevealed = useCallback((paths: readonly string[]) => {
    setExpandedPaths((current) => new Set([...current, ...paths]));
  }, []);
  const reveal = useFilesReveal({
    worktreeId,
    target: surface.filesReveal,
    tree,
    rootState: error ? 'failed' : loading ? 'loading' : 'loaded',
    loadSubtree: fetchSubtree,
    expand: expandRevealed,
  });
  const revealedPath = reveal.status === 'revealed' ? reveal.selected : null;
  // A revealed directory shows its contents too; its listing loads the same way a click would load it.
  useEffect(() => {
    if (!revealedPath) return;
    const node = findNode(tree, revealedPath);
    if (node?.type === 'directory' && node.children === undefined) void fetchSubtree(revealedPath);
  }, [fetchSubtree, revealedPath, tree]);

  const selectWorktree = useCallback(
    (nextWorktreeId: string) => {
      const selected = worktrees.find((entry) => matchesWorktreeIdentity(entry, nextWorktreeId, exactIdentity));
      if (!selected) return;
      if (selected.id === target?.worktreeId) return;
      setWorkspaceWorktreeId(selected.id);
      // The choices were listed through this tree's coordinate, so the next tree keeps it.
      onOpenSurface(createFilesSurface(selected.id, target?.repoRoot ? { repoRoot: target.repoRoot } : {}));
    },
    [exactIdentity, onOpenSurface, setWorkspaceWorktreeId, target?.repoRoot, target?.worktreeId, worktrees],
  );

  const openFile = useCallback(
    (path: string, scrollToLine?: number | null) => {
      if (!target) return;
      onOpenSurface(
        createFileSurface({
          worktreeId: target.worktreeId,
          path,
          scrollToLine,
          navigationOrigin: {
            kind: 'file-tree',
            worktreeId: target.worktreeId,
            ...(target.repoRoot ? { repoRoot: target.repoRoot } : {}),
          },
          ...(identity?.resolvedRoot && identity.rootEpoch !== undefined
            ? {
                rootSelection: {
                  root: identity.resolvedRoot,
                  branch: identity.branch,
                  expectedEpoch: identity.rootEpoch,
                },
              }
            : {}),
        }),
      );
    },
    [onOpenSurface, target, identity],
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
          {onReturnToNavigationOrigin && (
            <button
              type="button"
              onClick={onReturnToNavigationOrigin}
              className="shrink-0 rounded-md px-1.5 py-1 font-semibold text-cafe-accent hover:bg-cafe-surface-sunken"
            >
              返回来源
            </button>
          )}
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
              {/* The tree already names its worktree; an unconfirmed identity is shown as that id, never "choose". */}
              {!identity && <option value={target.worktreeId}>{target.worktreeId}</option>}
              {worktrees.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {worktreeLabel(entry)}
                </option>
              ))}
            </select>
          </label>
          {identity && (
            <LinkedRootRemoveButton
              id={identity.id}
              expectedEpoch={identity.connectionEpoch}
              removable={identity.removable}
              onRemoved={() => {
                setTree([]);
                setError(true);
                rereadIdentity();
              }}
            />
          )}
          <span className="text-cafe-interactive/45">branch</span>
          <code className="max-w-[32%] truncate rounded bg-cafe-surface-sunken px-1.5 py-0.5 text-micro text-cafe-interactive">
            {identity?.branch ?? IDENTITY_PLACEHOLDER[identityState.state]}
          </code>
          <span className="text-cafe-interactive/45">HEAD</span>
          <code
            className="max-w-[24%] truncate rounded bg-cafe-surface-sunken px-1.5 py-0.5 text-micro text-cafe-interactive"
            data-testid="f307-files-worktree-head"
          >
            {identity ? worktreeHeadLabel(identity.head) : IDENTITY_PLACEHOLDER[identityState.state]}
          </code>
        </div>
        <div className="mt-1 truncate font-mono text-micro text-cafe-interactive/50" title={rootLabel}>
          {rootLabel}
        </div>
        {IDENTITY_STATUS[identityState.state] ? (
          <p
            role="status"
            className="mt-1 text-micro text-cafe-muted"
            data-testid="f307-files-worktree-identity-status"
            data-identity-state={identityState.state}
          >
            {IDENTITY_STATUS[identityState.state]}
            <button type="button" onClick={rereadIdentity} className="ml-2 font-semibold text-cafe-accent">
              重新读取
            </button>
          </p>
        ) : null}
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
      <F307FilesRevealStatus reveal={reveal} />
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
        selectedPath={revealedPath}
        hasFile={false}
        callbacks={treeCallbacks}
        emptyTitle="这个工作区还没有文件"
        emptyDescription="可以新建或上传文件，也可以从 Workspace Home 打开另一个工作区"
      />
    </div>
  );
}
