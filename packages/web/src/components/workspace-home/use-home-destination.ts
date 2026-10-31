'use client';

import { useCallback } from 'react';
import type { WorkspaceDevSurface, WorkspaceLauncherDestination } from '@/components/workspace/WorkspaceLauncher';
import { useChatStore } from '@/stores/chatStore';

/**
 * Surface/mode selection keeps the classic store actions. Replay is admitted by the
 * v2 host's descriptor callback, so Home does not also emit the native sidebar event.
 * The host owns worktree admission, pending destinations and owner references.
 */
export function useHomeDestinationSelect({
  onSelectDevSurface,
  onSelectDestination,
}: {
  onSelectDevSurface?: (surface: WorkspaceDevSurface) => void;
  onSelectDestination: (destination: WorkspaceLauncherDestination) => void;
}): (destination: WorkspaceLauncherDestination) => void {
  const setWorkspaceMode = useChatStore((state) => state.setWorkspaceMode);
  const openTeamSubject = useChatStore((state) => state.openTeamSubject);
  return useCallback(
    (destination) => {
      if (destination.kind === 'surface') {
        setWorkspaceMode('dev');
        onSelectDevSurface?.(destination.id);
      } else if (destination.kind === 'mode') {
        if (destination.id === 'team') openTeamSubject(null);
        else setWorkspaceMode(destination.id);
      }
      onSelectDestination(destination);
    },
    [onSelectDestination, onSelectDevSurface, openTeamSubject, setWorkspaceMode],
  );
}
