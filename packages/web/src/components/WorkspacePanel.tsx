'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useChatStore } from '@/stores/chatStore';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { kickTeleportResolve, planTeleport } from '@/utils/teleport';
import { worktreeBasename } from '@/utils/worktree-label';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';
import { useF307ExperienceWorkbenchStore } from './workbench/experience-workbench-store';
import { F307ExperienceWorkbench } from './workbench/F307ExperienceWorkbench';
import { createBrowserSurface, createFileSurface } from './workbench/real-surface-adapters';

export function WorkspacePanel({
  threadId,
  defaultCatId = 'opus',
  visible = true,
  statusSurface,
  artifactWorkHostAvailable = false,
}: {
  threadId?: string;
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
  } = useWorkspace({ loadContent: false });
  const router = useRouter();
  const currentWorktree = worktrees.find((worktree) => worktree.id === worktreeId);
  const setOpenFile = useChatStore((state) => state.setWorkspaceOpenFile);
  const openFilePath = useChatStore((state) => state.workspaceOpenFilePath);
  const openFileLine = useChatStore((state) => state.workspaceOpenFileLine);
  const workspaceFileSetAt = useChatStore((state) => state._workspaceFileSetAt);
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
    if (workspaceFileSetAt.ts === lastWorkspaceFileSetAtRef.current) return;
    lastWorkspaceFileSetAtRef.current = workspaceFileSetAt.ts;
    if (!openFilePath || !worktreeId) return;
    if (workspaceFileSetAt.threadId && workspaceFileSetAt.threadId !== currentThreadId) return;
    setViewMode('files');
    useF307ExperienceWorkbenchStore.getState().dispatch({
      type: 'open-surface',
      surface: createFileSurface({
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
      }),
      entitlement: { kind: 'user', reason: 'open-from-chat' },
    });
  }, [
    currentThreadId,
    currentWorktree,
    openFileLine,
    openFilePath,
    setViewMode,
    workspaceFileSetAt.threadId,
    workspaceFileSetAt.navigationOrigin,
    workspaceFileSetAt.ts,
    worktreeId,
  ]);

  const handleSearchResultClick = useCallback(
    (path: string, line: number) => {
      const query = lastWorkspaceSearchQueryRef.current.trim();
      setOpenFile(path, line, undefined, undefined, query ? { kind: 'workspace-home-search', query } : undefined);
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
  const restoreWorkspaceSearch = useCallback(
    (query: string) => {
      lastWorkspaceSearchQueryRef.current = query;
      void search(query, 'all');
    },
    [search],
  );
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
  const activeWorktreeId = currentWorktree?.id ?? null;

  return (
    <F307ExperienceWorkbench
      threadId={threadId}
      defaultCatId={defaultCatId}
      visible={visible}
      statusSurface={statusSurface}
      artifactWorkHostAvailable={artifactWorkHostAvailable}
      onSelectDevSurface={setViewMode}
      worktreeId={activeWorktreeId}
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
      f284WorkspaceState={
        workspaceMode === 'team' ||
        (viewMode === 'files' && openFilePath) ||
        (viewMode === 'browser' && workspacePreview.port)
          ? {
              threadId,
              workspaceMode,
              workspaceSurface: viewMode,
              workspaceOpenFilePath: openFilePath,
              workspaceOpenFileLine: openFileLine,
              workspaceWorktreeId: worktreeId,
              workspacePreview,
              teamWorkspaceSubject,
              rightPanelOpen: true,
            }
          : undefined
      }
      workspaceOpenRequest={workspaceOpenRequest}
      onWorkspaceOpenRequestConsumed={consumeWorkspaceOpenRequest}
      onRestoreWorkspaceSearch={restoreWorkspaceSearch}
      onReturnToChatMessage={returnToChatMessage}
      onOpenAppRoute={(href) => router.push(href)}
    />
  );
}
