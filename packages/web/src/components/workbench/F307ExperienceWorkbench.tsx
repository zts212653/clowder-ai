'use client';

import { createMessagePublicationSurface } from './message-publication-surface';

/*
Architecture cell: hub-action-surface
Real-shell host for the shared F307 Workbench kernel.
*/

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ListenModePlayer } from '@/components/listen-mode/ListenModePlayer';
import type {
  F284WorkspaceSnapshot,
  WorkbenchAction,
  WorkbenchLayoutState,
} from '@/components/workbench/workbench-contract';
import { projectWorkbench } from '@/components/workbench/workbench-model';
import type { WorkspaceDevSurface } from '@/components/workspace/WorkspaceLauncher';
import type { LauncherWorkspaceSearch } from '@/components/workspace/WorkspaceLauncherSearch';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import type { WorkspaceOpenRequest } from '@/stores/chat-types';
import { isArtifactWorkSurface } from './artifact-work-presentation';
import { toggleArtifactWorkFullWindow } from './artifact-work-presentation-actions';
import { restoreEvolutionMediaOrigin } from './evolution-media-navigation';
import { useF307ExperienceWorkbenchStore } from './experience-workbench-store';
import { F307OwnerSurfaceRenderer } from './F307OwnerSurfaceRenderer';
import { F307SurfacePane } from './F307SurfacePane';
import { F307WorkbenchSidecar } from './F307WorkbenchSidecar';
import { F307WorkbenchTabs } from './F307WorkbenchTabs';
import { F307WorkspaceHomePage } from './F307WorkspaceHomePage';
import { createPublicationSurface } from './publication-surface';
import {
  createArtifactSurface,
  createEvolutionProgramSurface,
  createFileSurface,
  createFilesSurface,
  createTeamWorkspaceSurface,
  createWorkspaceModeSurface,
  resolveFileTarget,
} from './real-surface-adapters';
import { returnFileCard } from './return-file-card';
import { workspaceFileReturnAction } from './workspace-file-return';

function WorkbenchActivity({
  layout,
  dispatch,
}: {
  layout: WorkbenchLayoutState;
  dispatch: (action: WorkbenchAction) => void;
}) {
  return layout.activity.map((item) => (
    <div
      key={item.id}
      className="flex shrink-0 items-center gap-3 border-b border-[var(--semantic-info)]/20 bg-[var(--semantic-info-surface)] px-3 py-2"
      data-testid={`f307-activity-${item.kind}`}
    >
      <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--semantic-info)]" aria-hidden="true" />
      <p className="min-w-0 flex-1 truncate text-xs text-cafe-secondary">{item.message}</p>
      {item.surface && (
        <button
          type="button"
          onClick={() => {
            if (!item.surface) return;
            dispatch({
              type: 'open-surface',
              surface: item.surface,
              entitlement: { kind: 'user', reason: 'surface-tab' },
            });
            dispatch({ type: 'dismiss-activity', activityId: item.id });
          }}
          className="text-xs font-semibold text-[var(--semantic-info)] hover:underline"
        >
          查看
        </button>
      )}
      <button
        type="button"
        onClick={() => dispatch({ type: 'dismiss-activity', activityId: item.id })}
        className="flex h-6 w-6 items-center justify-center rounded-md text-cafe-muted hover:bg-cafe-surface"
        aria-label="关闭提醒"
      >
        <span className="h-3.5 w-3.5">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </span>
      </button>
    </div>
  ));
}

function RecentlyClosedSurfaces({
  layout,
  dispatch,
  onRestore,
}: {
  layout: WorkbenchLayoutState;
  dispatch: (action: WorkbenchAction) => void;
  onRestore: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (layout.recentlyClosed.length === 0) return null;
  return (
    <aside
      className="shrink-0 border-t border-cafe-subtle bg-[var(--console-panel-bg)] px-3 py-2"
      data-testid="f307-recently-closed"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="rounded-lg px-2 py-1 text-micro font-semibold text-cafe-muted hover:bg-cafe-surface-sunken hover:text-cafe"
          aria-expanded={expanded}
          aria-label={`${expanded ? '收起' : '展开'}最近关闭的工作区页面`}
          data-testid="f307-recently-closed-toggle"
        >
          最近关闭 {layout.recentlyClosed.length}
        </button>
        {expanded &&
          layout.recentlyClosed.map((surface) => (
            <button
              key={surface.id}
              type="button"
              onClick={() => {
                dispatch({
                  type: 'restore-surface',
                  surfaceId: surface.id,
                  entitlement: { kind: 'user', reason: 'recently-closed' },
                });
                setExpanded(false);
                onRestore();
              }}
              className="rounded-lg bg-cafe-surface-sunken px-2 py-1 text-micro font-semibold text-cafe-secondary hover:text-cafe"
              data-testid={`f307-restore-${surface.type}`}
            >
              恢复 {surface.title}
            </button>
          ))}
      </div>
    </aside>
  );
}

function zeroTopologyContract(hydrated: boolean, zeroTopology: boolean, homeFocused: boolean): string {
  if (!hydrated) return 'pending-hydration';
  if (zeroTopology && homeFocused) return 'canonical-home';
  return 'not-applicable';
}

function useExplicitWorkspaceNavigation({
  dispatch,
  hydrated,
  layout,
  request,
  onConsumed,
  setHomeOpen,
  threadId,
}: {
  dispatch: (action: WorkbenchAction) => void;
  hydrated: boolean;
  layout: WorkbenchLayoutState;
  request?: WorkspaceOpenRequest | null;
  onConsumed?: (revision: number) => void;
  setHomeOpen: (open: boolean) => void;
  threadId?: string;
}) {
  const consumedRevision = useRef(0);
  useEffect(() => {
    if (
      !hydrated ||
      !request ||
      request.revision <= consumedRevision.current ||
      (request.threadId && request.threadId !== threadId)
    ) {
      return;
    }
    const surface =
      request.target.kind === 'message-publication'
        ? createMessagePublicationSurface(request.target.source, request.target.title)
        : request.target.kind === 'publication'
          ? createPublicationSurface(request.target)
          : request.target.kind === 'team'
            ? createTeamWorkspaceSurface({ threadId, subject: request.target.subject })
            : request.target.kind === 'evolution-program'
              ? createEvolutionProgramSurface(request.target.programId)
              : request.target.kind === 'artifact'
                ? createArtifactSurface({
                    threadId: request.threadId,
                    artifact: request.target.artifact,
                    navigationOrigin: request.target.navigationOrigin,
                  })
                : request.target.kind === 'file'
                  ? createFileSurface({
                      worktreeId: request.target.worktreeId,
                      path: request.target.path,
                      scrollToLine: request.target.line ?? null,
                      navigationOrigin: request.target.navigationOrigin,
                    })
                  : request.target.kind === 'reveal'
                    ? createFilesSurface(request.target.worktreeId, {
                        reveal: { path: request.target.path, request: request.revision },
                        navigationOrigin: request.target.navigationOrigin,
                        repoRoot: request.target.repoRoot,
                      })
                    : createWorkspaceModeSurface(request.target.mode, threadId);
    consumedRevision.current = request.revision;
    const existing = layout.surfaces.find((candidate) => candidate.id === surface.id);
    // A reveal is an action on the tree, so asking again re-runs it even when the same tree is showing.
    const alreadyFocused =
      request.target.kind !== 'reveal' &&
      layout.activeSurfaceId === surface.id &&
      existing?.ownerStateRef.key === surface.ownerStateRef.key &&
      existing?.resultTargetRef?.owner === surface.resultTargetRef?.owner &&
      existing?.resultTargetRef?.key === surface.resultTargetRef?.key;
    if (!alreadyFocused) {
      dispatch({
        type: 'open-surface',
        surface,
        entitlement: { kind: 'user', reason: 'open-from-chat' },
      });
    }
    setHomeOpen(false);
    if (request.target.kind === 'evolution-program') {
      useF307ExperienceWorkbenchStore.getState().enterMainAreaAttention(surface.id);
    }
    onConsumed?.(request.revision);
  }, [dispatch, hydrated, layout.activeSurfaceId, layout.surfaces, onConsumed, request, setHomeOpen, threadId]);
}

function ownerSurfaceVisible(
  workbenchVisible: boolean,
  homeFocused: boolean,
  visibleSurfaceIds: ReadonlySet<string>,
  surfaceId: string,
): boolean {
  return workbenchVisible && !homeFocused && visibleSurfaceIds.has(surfaceId);
}

function ownerSidecarVisible(
  workbenchVisible: boolean,
  homeFocused: boolean,
  mainAreaAttentionSurfaceId: string | null,
  focusSurfaceId: string | null,
): boolean {
  return workbenchVisible && !homeFocused && mainAreaAttentionSurfaceId === null && focusSurfaceId === null;
}

export function F307ExperienceWorkbench({
  threadId,
  defaultCatId = 'opus',
  visible = true,
  statusSurface,
  artifactWorkHostAvailable = false,
  onSelectDevSurface,
  f284WorkspaceState,
  worktreeId,
  worktreeLoading = false,
  worktreeError = null,
  openFilePath,
  preview,
  repository,
  rootSelection,
  workspaceSearch,
  workspaceOpenRequest,
  onWorkspaceOpenRequestConsumed,
  onRestoreWorkspaceSearch,
  onReturnToChatMessage,
  onOpenAppRoute,
}: {
  threadId?: string;
  defaultCatId?: string;
  visible?: boolean;
  statusSurface?: ReactNode;
  artifactWorkHostAvailable?: boolean;
  onSelectDevSurface: (surface: WorkspaceDevSurface) => void;
  f284WorkspaceState?: F284WorkspaceSnapshot;
  worktreeId: string | null;
  worktreeLoading?: boolean;
  worktreeError?: string | null;
  openFilePath: string | null;
  preview: { port?: number; path: string };
  repository?: { name: string; branch: string };
  rootSelection?: import('./workspace-root-selection').WorkspaceRootSelection;
  workspaceSearch?: LauncherWorkspaceSearch;
  workspaceOpenRequest?: WorkspaceOpenRequest | null;
  onWorkspaceOpenRequestConsumed?: (revision: number) => void;
  onRestoreWorkspaceSearch?: (query: string) => void;
  onReturnToChatMessage?: (input: { threadId: string; messageId: string }) => void;
  /**
   * Leaves the workbench for another app route (e.g. a Settings file card). The host owns routing,
   * so the workbench kernel stays mountable outside the Next app router.
   */
  onOpenAppRoute: (href: string) => void;
}) {
  const isDesktop = useIsDesktop();
  const [homeOpen, setHomeOpen] = useState(false);
  const [homeSearchQuery, setHomeSearchQuery] = useState('');
  const layout = useF307ExperienceWorkbenchStore((state) => state.layout);
  const hydrated = useF307ExperienceWorkbenchStore((state) => state.hydrated);
  const dispatch = useF307ExperienceWorkbenchStore((state) => state.dispatch);
  const hydrate = useF307ExperienceWorkbenchStore((state) => state.hydrate);
  const mainAreaAttentionSurfaceId = useF307ExperienceWorkbenchStore((state) => state.mainAreaAttentionSurfaceId);
  const enterMainAreaAttention = useF307ExperienceWorkbenchStore((state) => state.enterMainAreaAttention);
  const exitMainAreaAttention = useF307ExperienceWorkbenchStore((state) => state.exitMainAreaAttention);
  const focusSurfaceId = useF307ExperienceWorkbenchStore((state) => state.focusSurfaceId);
  const enterFocusMode = useF307ExperienceWorkbenchStore((state) => state.enterFocusMode);
  const exitFocusMode = useF307ExperienceWorkbenchStore((state) => state.exitFocusMode);
  /*
  Architecture cell: hub-action-surface
  This is a transient projection, not a second owner store.
  */
  const artifactWorkPresentation = useF307ExperienceWorkbenchStore((state) => state.artifactWorkPresentation);

  useEffect(() => {
    if (!hydrated) hydrate(f284WorkspaceState);
  }, [f284WorkspaceState, hydrate, hydrated]);

  useEffect(() => {
    if (!isDesktop && mainAreaAttentionSurfaceId !== null) exitMainAreaAttention();
  }, [exitMainAreaAttention, isDesktop, mainAreaAttentionSurfaceId]);

  useExplicitWorkspaceNavigation({
    dispatch,
    hydrated,
    layout,
    request: workspaceOpenRequest,
    onConsumed: onWorkspaceOpenRequestConsumed,
    setHomeOpen,
    threadId,
  });

  const projection = projectWorkbench(layout, isDesktop ? 1024 : 390);
  const zeroTopology = projection.visibleSurfaceIds.length === 0;
  const homeFocused = homeOpen || zeroTopology;
  const topologyContract = zeroTopologyContract(hydrated, zeroTopology, homeFocused);
  const visibleSurfaceIds = new Set(
    focusSurfaceId !== null
      ? [focusSurfaceId]
      : mainAreaAttentionSurfaceId === null
        ? projection.visibleSurfaceIds
        : [mainAreaAttentionSurfaceId],
  );

  useEffect(() => {
    if (focusSurfaceId !== null && (!visible || homeFocused)) exitFocusMode();
  }, [exitFocusMode, focusSurfaceId, homeFocused, visible]);
  const openSurfaceIds = new Set(layout.surfaces.map((surface) => surface.id));
  const hostedSurfaces = [
    ...layout.surfaces,
    ...layout.recentlyClosed.filter((surface) => !openSurfaceIds.has(surface.id)),
  ];
  const renderOwnerSurface = (surface: (typeof hostedSurfaces)[number], surfaceVisible: boolean) => (
    <F307OwnerSurfaceRenderer
      surface={surface}
      surfaceVisible={surfaceVisible}
      focusMode={focusSurfaceId === surface.id}
      statusSurface={statusSurface}
      onOpenSurface={(nextSurface) => {
        dispatch({
          type: 'open-surface',
          surface: nextSurface,
          entitlement: { kind: 'user', reason: 'workspace-home-selection' },
        });
      }}
      onOpenArtifactWithReturn={({ artifact, returnSurface }) => {
        dispatch({
          type: 'open-artifact-with-return',
          artifact,
          returnSurface,
          presentation: isDesktop ? 'desktop' : 'mobile',
          entitlement: { kind: 'user', reason: 'workspace-home-selection' },
        });
      }}
      onRefreshSurface={(nextSurface) => dispatch({ type: 'refresh-surface', surface: nextSurface })}
      onReturnToFileOrigin={(fileSurface, origin) => {
        if (origin.kind === 'artifact-list') {
          const list = createWorkspaceModeSurface('artifacts', origin.threadId);
          dispatch({
            type: 'open-surface',
            surface: { ...list, artifactListView: origin.view },
            entitlement: { kind: 'user', reason: 'return-origin' },
          });
          exitMainAreaAttention();
          return;
        }
        if (origin.kind === 'evolution-media') {
          const program = restoreEvolutionMediaOrigin(origin);
          if (!program) return;
          dispatch({ type: 'open-surface', surface: program, entitlement: { kind: 'user', reason: 'return-origin' } });
          if (origin.expanded && isDesktop) enterMainAreaAttention(program.id);
          else exitMainAreaAttention();
          return;
        }
        if (origin.kind === 'chat-file-link') {
          exitMainAreaAttention();
          onReturnToChatMessage?.({ threadId: origin.threadId, messageId: origin.messageId });
          return;
        }
        // A Settings or status card entry returns to its page; it needs no file target, so a files
        // surface opened from such an entry (a revealed directory) returns the same way.
        if (origin.kind === 'settings' || origin.kind === 'workspace-card') {
          exitMainAreaAttention();
          returnFileCard(origin, onOpenAppRoute, dispatch);
          return;
        }
        const target = resolveFileTarget(fileSurface);
        if (!target) return;
        exitMainAreaAttention();
        const action = workspaceFileReturnAction(origin, target.worktreeId);
        if (action.kind === 'artifact-list') return;
        if (action.kind === 'workspace-document') {
          dispatch({
            type: 'open-surface',
            surface: createFileSurface({ worktreeId: action.worktreeId, path: action.path, scrollToLine: action.line }),
            entitlement: { kind: 'user', reason: 'return-origin' },
          });
          return;
        }
        if (action.kind === 'file-tree') {
          dispatch({
            type: 'open-surface',
            surface: createFilesSurface(action.worktreeId, action.repoRoot ? { repoRoot: action.repoRoot } : {}),
            entitlement: { kind: 'user', reason: 'return-origin' },
          });
          return;
        }
        if (action.kind === 'workspace-home-search') {
          setHomeSearchQuery(action.query);
          onRestoreWorkspaceSearch?.(action.query);
          setHomeOpen(true);
          return;
        }
        if (action.kind === 'chat-file-link') {
          onReturnToChatMessage?.({ threadId: action.threadId, messageId: action.messageId });
        }
      }}
      onRequestDetach={() => {
        if (
          surface.returnTargetRef ||
          surface.type === 'artifact' ||
          surface.ownerStateRef.owner === 'f309-content-review'
        ) {
          dispatch({
            type: 'close-artifact-to-return',
            artifactSurfaceId: surface.id,
            entitlement: { kind: 'user', reason: 'close-button' },
          });
          return;
        }
        dispatch({
          type: 'close-surface',
          surfaceId: surface.id,
          entitlement: { kind: 'user', reason: 'close-button' },
        });
      }}
    />
  );

  return (
    <section
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--console-panel-bg)]"
      data-testid="f307-experience-workbench"
      data-layout-owner={layout.layoutOwner}
      data-layout-hydrated={hydrated}
      data-layout-kind={projection.kind}
      data-active-surface={layout.activeSurfaceId ?? ''}
      data-surface-count={layout.surfaces.length}
      data-split-primary={layout.split?.primarySurfaceId ?? ''}
      data-split-secondary={layout.split?.secondarySurfaceId ?? ''}
      data-sidecar-surface={layout.sidecar?.id ?? ''}
      data-surface-order={layout.surfaces.map((surface) => surface.id).join(',')}
      data-pinned-surfaces={layout.pinnedSurfaceIds.join(',')}
      data-workbench-focus={homeFocused ? 'home' : 'surface'}
      data-zero-topology-contract={topologyContract}
      data-main-area-attention={mainAreaAttentionSurfaceId ?? ''}
      data-focus-surface={focusSurfaceId ?? ''}
    >
      <ListenModePlayer />
      {!zeroTopology && focusSurfaceId === null && (
        <F307WorkbenchTabs
          layout={layout}
          dispatch={dispatch}
          onAddSurface={() => {
            exitMainAreaAttention();
            setHomeSearchQuery('');
            setHomeOpen(true);
          }}
          onActivateSurface={() => setHomeOpen(false)}
          homeFocused={homeFocused}
          isDesktop={isDesktop}
          artifactWorkHostAvailable={artifactWorkHostAvailable}
          mainAreaAttentionSurfaceId={mainAreaAttentionSurfaceId}
          onEnterMainAreaAttention={enterMainAreaAttention}
          onExitMainAreaAttention={exitMainAreaAttention}
        />
      )}

      {!homeFocused && focusSurfaceId === null && <WorkbenchActivity layout={layout} dispatch={dispatch} />}

      {homeFocused && (
        <F307WorkspaceHomePage
          threadId={threadId}
          defaultCatId={defaultCatId}
          onSelectDevSurface={onSelectDevSurface}
          worktreeId={worktreeId}
          worktreeLoading={worktreeLoading}
          worktreeError={worktreeError}
          openFilePath={openFilePath}
          preview={preview}
          repository={repository}
          rootSelection={rootSelection}
          workspaceSearch={workspaceSearch}
          workspaceSearchQuery={homeSearchQuery}
          onSelectSurface={(surface) => {
            dispatch({
              type: 'open-surface',
              surface,
              entitlement: { kind: 'user', reason: 'workspace-home-selection' },
            });
            setHomeOpen(false);
          }}
        />
      )}
      <div
        className={`${homeFocused ? 'hidden' : 'flex'} min-h-0 flex-1 flex-col md:flex-row`}
        aria-hidden={homeFocused}
        data-testid="f307-mounted-surface-host"
      >
        <div
          className={`flex min-h-0 min-w-0 flex-1 ${projection.kind === 'split' ? 'divide-x divide-cafe-subtle' : ''}`}
        >
          {hostedSurfaces.map((surface) => (
            <F307SurfacePane
              key={surface.id}
              surface={surface}
              visible={visibleSurfaceIds.has(surface.id)}
              focusMode={focusSurfaceId === surface.id}
              artifactWorkFullWindow={
                artifactWorkPresentation.session?.threadId === threadId &&
                artifactWorkPresentation.session?.surfaceId === surface.id &&
                artifactWorkPresentation.session?.mode === 'full-window'
              }
              onToggleArtifactWorkFullWindow={
                artifactWorkHostAvailable &&
                isDesktop &&
                threadId &&
                layout.activeSurfaceId === surface.id &&
                isArtifactWorkSurface(surface)
                  ? () => {
                      toggleArtifactWorkFullWindow(threadId, surface);
                    }
                  : undefined
              }
              onEnterFocusMode={() => {
                if (layout.activeSurfaceId !== surface.id) {
                  dispatch({
                    type: 'activate-surface',
                    surfaceId: surface.id,
                    entitlement: { kind: 'user', reason: 'surface-tab' },
                  });
                }
                setHomeOpen(false);
                enterFocusMode(surface.id);
              }}
              onExitFocusMode={exitFocusMode}
            >
              {renderOwnerSurface(surface, ownerSurfaceVisible(visible, homeFocused, visibleSurfaceIds, surface.id))}
            </F307SurfacePane>
          ))}
        </div>
        {layout.sidecar !== null && (
          <F307WorkbenchSidecar
            surface={layout.sidecar}
            dispatch={dispatch}
            renderSurface={renderOwnerSurface}
            visible={ownerSidecarVisible(visible, homeFocused, mainAreaAttentionSurfaceId, focusSurfaceId)}
          />
        )}
      </div>

      {focusSurfaceId === null && (
        <RecentlyClosedSurfaces layout={layout} dispatch={dispatch} onRestore={() => setHomeOpen(false)} />
      )}
    </section>
  );
}
