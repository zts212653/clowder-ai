'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { useWorkspace } from '@/hooks/useWorkspace';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { hasPendingWorkspaceFileLink } from '@/utils/pending-workspace-file-link';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { kickTeleportResolve, planTeleport } from '@/utils/teleport';
import { resolveListedWorktreeId } from '@/utils/worktree-id-alias';
import { worktreeBasename } from '@/utils/worktree-label';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';
import { useF307ExperienceWorkbenchStore } from './workbench/experience-workbench-store';
import { F307ExperienceWorkbench } from './workbench/F307ExperienceWorkbench';
import { createBrowserSurface } from './workbench/real-surface-adapters';
import { canConsumeWorkspaceFileStamp, openWorkspaceFileStamp } from './workbench/workspace-file-open';
import { readF284WorkspaceSnapshot } from './workbench/workspace-legacy-snapshot';
import { bindWorkspaceForeground } from './workbench/workspace-presentation-lock';

export function WorkspacePanel({
  threadId,
  projectPath,
  defaultCatId = 'opus',
  visible = true,
  statusSurface,
  artifactWorkHostAvailable = false,
}: {
  threadId?: string;
  /** The owning chat's resolved project, or null while its metadata is pending. */
  projectPath?: string | null;
  defaultCatId?: string;
  visible?: boolean;
  statusSurface?: ReactNode;
  artifactWorkHostAvailable?: boolean;
}) {
  const {
    worktrees,
    worktreesLoading,
    worktreesError,
    worktreeId,
    searchResults,
    searchLoading,
    searchError,
    search,
    resetSearch,
  } = useWorkspace({ loadContent: false, projectPath });
  const router = useRouter();
  const isV2 = useShellPresentation() === 'v2';
  const foregroundSurfaceId = useChatStore((state) => state.workspaceForegroundSurfaceId);
  const listedWorktreeId = resolveListedWorktreeId(worktrees, worktreeId);
  const currentWorktree = worktrees.find((worktree) => worktree.id === listedWorktreeId);
  const setOpenFile = useChatStore((state) => state.setWorkspaceOpenFile);
  const openFilePath = useChatStore((state) => state.workspaceOpenFilePath);
  const openFileLine = useChatStore((state) => state.workspaceOpenFileLine);
  const workspaceFileSetAt = useChatStore((state) => state._workspaceFileSetAt);
  const pendingFileLink = useChatStore(hasPendingWorkspaceFileLink);
  const consumeWorkspaceFileSetAt = useChatStore((state) => state.consumeWorkspaceFileSetAt);
  const hydrated = useF307ExperienceWorkbenchStore((state) => state.hydrated);
  const currentThreadId = useChatStore((state) => state.currentThreadId);
  const pendingPreviewAutoOpen = useChatStore((state) => state.pendingPreviewAutoOpen);
  const consumePreviewAutoOpen = useChatStore((state) => state.consumePreviewAutoOpen);
  const workspaceMode = useChatStore((state) => state.workspaceMode);
  const teamWorkspaceSubject = useChatStore((state) => state.teamWorkspaceSubject);
  const workspaceOpenRequest = useChatStore((state) => state.workspaceOpenRequest);
  const consumeWorkspaceOpenRequest = useChatStore((state) => state.consumeWorkspaceOpenRequest);
  const viewMode = useChatStore((state) => state.workspaceSurface);
  const setViewMode = useChatStore((state) => state.setWorkspaceSurface);
  const workspacePreview = useChatStore((state) => state.workspacePreview);
  const setWorkspacePreview = useChatStore((state) => state.setWorkspacePreview);
  const closeRightPanel = useChatStore((state) => state.closeRightPanel);
  const lastWorkspaceFileSetAtRef = useRef(workspaceFileSetAt.ts);
  const lastWorkspaceSearchQueryRef = useRef('');
  const fileStampReady = canConsumeWorkspaceFileStamp({
    stamp: workspaceFileSetAt,
    pendingFileLink,
    lastTimestamp: lastWorkspaceFileSetAtRef.current,
    hydrated,
    threadId: currentThreadId,
  });

  useEffect(() => (isV2 ? bindWorkspaceForeground() : undefined), [isV2]);

  useEffect(() => {
    if (!pendingPreviewAutoOpen) return;
    const preview = consumePreviewAutoOpen();
    if (!preview) return;
    setWorkspacePreview(preview);
    useF307ExperienceWorkbenchStore.getState().dispatch({
      type: 'open-surface',
      surface: createBrowserSurface({ ownerKey: worktreeId ?? 'current-project', ...preview }),
      entitlement: { kind: 'background', reason: 'owner-background' },
    });
  }, [consumePreviewAutoOpen, pendingPreviewAutoOpen, setWorkspacePreview, worktreeId]);

  useEffect(() => {
    if (!fileStampReady) return;
    // Discovery supplies an alias, while a resolved file owner supplies a canonical root.
    // Both are valid coordinates; the owner resolver, rather than the alias list, validates them.
    if (!openFilePath || !worktreeId) return;
    setViewMode('files');
    openWorkspaceFileStamp(
      {
        worktreeId,
        path: openFilePath,
        scrollToLine: openFileLine,
        navigationOrigin: workspaceFileSetAt.navigationOrigin,
        ...(currentWorktree?.resolvedRoot && currentWorktree.rootEpoch !== undefined
          ? {
              rootSelection: {
                root: currentWorktree.resolvedRoot,
                branch: currentWorktree.branch,
                expectedEpoch: currentWorktree.rootEpoch,
              },
            }
          : {}),
      },
      isV2,
      workspaceFileSetAt.disposition,
      workspaceFileSetAt.threadId ?? undefined,
    );
    lastWorkspaceFileSetAtRef.current = workspaceFileSetAt.ts;
    if (pendingFileLink) consumeWorkspaceFileSetAt(workspaceFileSetAt);
  }, [
    consumeWorkspaceFileSetAt,
    currentWorktree,
    fileStampReady,
    openFileLine,
    openFilePath,
    setViewMode,
    workspaceFileSetAt,
    pendingFileLink,
    worktreeId,
    isV2,
  ]);

  const handleSearchResultClick = useCallback(
    (path: string, line: number, origin?: WorkspaceFileNavigationOrigin) => {
      const query = lastWorkspaceSearchQueryRef.current.trim();
      setOpenFile(
        path,
        line,
        undefined,
        undefined,
        origin ?? (query ? { kind: 'workspace-home-search', query } : undefined),
      );
      setViewMode('files');
      resetSearch();
    },
    [resetSearch, setOpenFile, setViewMode],
  );
  const handleLauncherSearch = useCallback(
    async (query: string) => {
      lastWorkspaceSearchQueryRef.current = query;
      await search(query, 'all');
    },
    [search],
  );
  // Architecture cell: hub-action-surface. F307 returns origin intent; this host executes it.
  const restoreWorkspaceSearch = useCallback((query: string) => {
    lastWorkspaceSearchQueryRef.current = query;
    // The restored real Launcher reissues this query through its one debounce; do not race it with a direct search.
  }, []);
  const returnToChatMessage = useCallback(
    ({ threadId: originThreadId, messageId }: { threadId: string; messageId: string }) => {
      const plan = planTeleport({ threadId: originThreadId, messageId, currentThreadId });
      closeRightPanel();
      if (plan.navigateTo && typeof window !== 'undefined') pushThreadRouteWithHistory(plan.navigateTo, window);
      if (plan.scrollNow) {
        scrollToMessage(plan.scrollNow);
        kickTeleportResolve();
      }
    },
    [closeRightPanel, currentThreadId],
  );
  const launcherWorkspaceSearch = useMemo(
    () => ({
      enabled: !!worktreeId,
      results: searchResults,
      loading: searchLoading,
      error: searchError,
      onSearch: handleLauncherSearch,
      onReset: resetSearch,
      onOpenResult: handleSearchResultClick,
      onViewAll: handleLauncherSearch,
      fileNavigationOrigin: () => {
        const query = lastWorkspaceSearchQueryRef.current.trim();
        return query ? ({ kind: 'workspace-home-search', query } as const) : undefined;
      },
    }),
    [handleLauncherSearch, handleSearchResultClick, resetSearch, searchError, searchLoading, searchResults, worktreeId],
  );
  // The list supplies display/epoch metadata; a content-owner id must keep F063's current authorization path.
  const activeWorktreeId = currentWorktree ? worktreeId : null;

  return (
    <F307ExperienceWorkbench
      foregroundSurfaceId={
        isV2 && (foregroundSurfaceId !== null || viewMode === 'home') ? foregroundSurfaceId : undefined
      }
      onOpenHome={
        isV2
          ? () => {
              useChatStore.getState().setWorkspaceForegroundSurfaceId(null);
              setViewMode('home');
            }
          : undefined
      }
      threadId={threadId}
      defaultCatId={defaultCatId}
      visible={visible}
      statusSurface={statusSurface}
      artifactWorkHostAvailable={artifactWorkHostAvailable}
      onSelectDevSurface={setViewMode}
      worktreeId={activeWorktreeId}
      canonicalWorktreeId={currentWorktree?.canonicalId ?? currentWorktree?.id ?? activeWorktreeId}
      rootSelection={
        currentWorktree?.resolvedRoot && currentWorktree.rootEpoch !== undefined
          ? {
              root: currentWorktree.resolvedRoot,
              branch: currentWorktree.branch,
              expectedEpoch: currentWorktree.rootEpoch,
            }
          : undefined
      }
      worktreeLoading={worktreesLoading}
      worktreeError={worktreesError}
      openFilePath={openFilePath}
      preview={workspacePreview}
      repository={
        currentWorktree ? { name: worktreeBasename(currentWorktree.root), branch: currentWorktree.branch } : undefined
      }
      workspaceSearch={launcherWorkspaceSearch}
      f284WorkspaceState={readF284WorkspaceSnapshot(
        {
          workspaceMode,
          workspaceSurface: viewMode,
          workspaceOpenFilePath: openFilePath,
          workspaceOpenFileLine: openFileLine,
          workspaceWorktreeId: worktreeId,
          workspacePreview,
          teamWorkspaceSubject,
        },
        pendingFileLink,
        threadId,
      )}
      workspaceOpenRequest={workspaceOpenRequest}
      onWorkspaceOpenRequestConsumed={consumeWorkspaceOpenRequest}
      onRestoreWorkspaceSearch={restoreWorkspaceSearch}
      onReturnToChatMessage={returnToChatMessage}
      onOpenAppRoute={(href) => router.push(href)}
    />
  );
}
