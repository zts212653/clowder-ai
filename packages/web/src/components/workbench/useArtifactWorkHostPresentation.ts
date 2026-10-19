'use client';

import { useCallback, useEffect } from 'react';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import {
  type ArtifactWorkInvalidationReason,
  type ArtifactWorkPresentationSession,
  DEFAULT_ARTIFACT_WORK_CHAT_BASIS,
} from './artifact-work-presentation';
import { useF307ExperienceWorkbenchStore } from './experience-workbench-store';
import type { WorkbenchLayoutState } from './workbench-contract';
import { projectWorkspaceWorkHost } from './workspace-work-host-projection';

interface ArtifactWorkHostInput {
  threadId: string;
  viewMode: 'single' | 'split';
  isDesktop: boolean;
  statusPanelOpen: boolean;
  rightPanelMode: 'status' | 'workspace' | 'transcript';
  currentThreadId?: string | null;
  mediaComposerSurfaceId?: string | null;
  workModeRequested?: boolean;
}

function invalidationReason(
  session: ArtifactWorkPresentationSession,
  threadId: string,
  layout: WorkbenchLayoutState,
  activeSurfaceId: string | null,
  hostEligible: boolean,
): ArtifactWorkInvalidationReason | null {
  if (session.threadId !== threadId) return 'thread-changed';
  if (!layout.surfaces.some((surface) => surface.id === session.surfaceId)) return 'surface-detached';
  if (activeSurfaceId !== session.surfaceId) return 'surface-changed';
  return hostEligible ? null : 'host-ineligible';
}

export function useArtifactWorkHostPresentation({
  threadId,
  viewMode,
  isDesktop,
  statusPanelOpen,
  rightPanelMode,
  currentThreadId,
  mediaComposerSurfaceId,
  workModeRequested,
}: ArtifactWorkHostInput) {
  const layout = useF307ExperienceWorkbenchStore((state) => state.layout);
  const presentation = useF307ExperienceWorkbenchStore((state) => state.artifactWorkPresentation);
  const attentionSurfaceId = useF307ExperienceWorkbenchStore((state) => state.mainAreaAttentionSurfaceId);
  const attentionPresentation = useF307ExperienceWorkbenchStore((state) => state.mainAreaAttentionPresentation);
  const dispatch = useF307ExperienceWorkbenchStore((state) => state.dispatchArtifactWorkPresentation);
  const {
    activeSurface,
    surfaceActive,
    hostEligible,
    workModeHostEligible,
    fullWindowActive,
    narrowWorkComposerActive,
    splitPreferenceActive,
    workspaceWideActive,
    workModeActive,
  } = projectWorkspaceWorkHost(
    {
      threadId,
      currentThreadId,
      mediaComposerSurfaceId,
      workModeRequested,
      viewMode,
      isDesktop,
      statusPanelOpen,
      rightPanelMode,
      shellPresentation: useShellPresentation(),
    },
    layout,
    presentation,
    { surfaceId: attentionSurfaceId, presentation: attentionPresentation },
  );

  const invalidateHost = useCallback(
    (reason: ArtifactWorkInvalidationReason = 'host-ineligible') => {
      const session = useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation.session;
      if (!session) return;
      dispatch({
        type: 'invalidate',
        initiator: 'host',
        reason,
        generation: session.generation,
        threadId: session.threadId,
        surfaceId: session.surfaceId,
      });
    },
    [dispatch],
  );

  useEffect(() => {
    const session = presentation.session;
    if (!session) return;
    const reason = invalidationReason(
      session,
      threadId,
      layout,
      activeSurface?.id ?? null,
      hostEligible || (session.workMode === true && workModeHostEligible),
    );
    if (!reason) return;
    dispatch({
      type: 'invalidate',
      initiator: 'host',
      reason,
      generation: session.generation,
      threadId: session.threadId,
      surfaceId: session.surfaceId,
    });
  }, [activeSurface?.id, dispatch, hostEligible, workModeHostEligible, layout, presentation.session, threadId]);

  useEffect(() => {
    if (!fullWindowActive) return;
    const leaveFromEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      // Match FloatingPresentationSurfaceHost: an interactive fullscreen overlay owns Escape first.
      if (document.querySelector('.fixed.inset-0:not(.pointer-events-none):not(.hidden):not(.invisible)')) {
        return;
      }
      const session = useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation.session;
      if (!session || session.mode !== 'full-window') return;
      event.preventDefault();
      dispatch({
        type: 'leave-full-window',
        initiator: 'user',
        generation: session.generation,
        threadId: session.threadId,
        surfaceId: session.surfaceId,
      });
    };
    window.addEventListener('keydown', leaveFromEscape);
    return () => window.removeEventListener('keydown', leaveFromEscape);
  }, [dispatch, fullWindowActive]);

  const resizeChatBasis = useCallback(
    (deltaPercent: number) => {
      const basis = useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation.desktopWorkChatBasis;
      dispatch({ type: 'set-chat-basis', initiator: 'user', basis: basis + deltaPercent });
    },
    [dispatch],
  );
  const resetChatBasis = useCallback(
    () =>
      dispatch({
        type: 'set-chat-basis',
        initiator: 'user',
        basis: DEFAULT_ARTIFACT_WORK_CHAT_BASIS,
      }),
    [dispatch],
  );

  return {
    surfaceActive,
    hostEligible,
    splitPreferenceActive,
    fullWindowActive,
    narrowWorkComposerActive,
    workspaceWideActive,
    workModeActive,
    chatBasis: presentation.desktopWorkChatBasis,
    invalidateHost,
    resizeChatBasis,
    resetChatBasis,
  };
}
