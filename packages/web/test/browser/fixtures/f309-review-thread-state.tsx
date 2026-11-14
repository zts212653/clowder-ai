import { useEffect, useLayoutEffect } from 'react';
import { getThreadIdFromPathname } from '@/components/ThreadSidebar/thread-navigation';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { createFileSurface } from '@/components/workbench/real-surface-adapters';
import { createInitialWorkbenchState } from '@/components/workbench/workbench-model';
import { bindWorkspaceForeground } from '@/components/workbench/workspace-presentation-lock';
import { DEFAULT_THREAD_STATE, useChatStore } from '@/stores/chatStore';

export const reviewNavigationState = (window as Window & { __F309_REVIEW_NAVIGATION__?: boolean })
  .__F309_REVIEW_NAVIGATION__;

if (reviewNavigationState) {
  const outgoing = createFileSurface({ worktreeId: 'outgoing', path: 'outgoing.md' });
  const saved = createFileSurface({ worktreeId: 'destination', path: 'saved.md' });
  useChatStore.setState({
    currentThreadId: 'thread-return',
    presentationLock: null,
    workspaceForegroundSurfaceId: outgoing.id,
    workspaceMode: 'dev',
    rightPanelMode: 'workspace',
    rightPanelOpen: true,
    threadStates: {
      'thread-other': {
        ...DEFAULT_THREAD_STATE,
        workspaceForegroundSurfaceId: saved.id,
        workspaceWorktreeId: 'destination',
        workspaceOpenFilePath: 'saved.md',
        workspaceMode: 'team',
        rightPanelOpen: false,
      },
    },
  });
  useF307ExperienceWorkbenchStore.setState({
    hydrated: true,
    layout: { ...createInitialWorkbenchState(), surfaces: [outgoing, saved], activeSurfaceId: outgoing.id },
  });
}

/** ChatContainer's route boundary invokes the real restoring store; F307's real foreground bridge runs too. */
export function ReviewThreadState({ pathname }: { pathname: string }) {
  useLayoutEffect(() => {
    if (pathname === '/' || pathname.startsWith('/thread/'))
      useChatStore.getState().setCurrentThread(getThreadIdFromPathname(pathname));
  }, [pathname]);
  useEffect(() => bindWorkspaceForeground(), []);
  const threadId = useChatStore((state) => state.currentThreadId);
  const foreground = useChatStore((state) => state.workspaceForegroundSurfaceId);
  const mode = useChatStore((state) => state.workspaceMode);
  const panelOpen = useChatStore((state) => state.rightPanelOpen);
  const panelMode = useChatStore((state) => state.rightPanelMode);
  const activeSurfaceId = useF307ExperienceWorkbenchStore((state) => state.layout.activeSurfaceId);
  return (
    <output data-testid="review-thread-state">
      {JSON.stringify({ threadId, foreground, mode, panelOpen, panelMode, activeSurfaceId })}
    </output>
  );
}
