'use client';

import { createContext, type ReactNode, useCallback, useContext } from 'react';
import { useF307ExperienceWorkbenchStore } from './experience-workbench-store';

const PreviewIntent = createContext<(() => void) | null>(null);

export function promoteWorkspacePreview(surfaceId: string) {
  const workbench = useF307ExperienceWorkbenchStore.getState();
  if (workbench.layout.previewSurfaceId !== surfaceId) return;
  workbench.dispatch({
    type: 'promote-preview-surface',
    surfaceId,
    entitlement: { kind: 'user', reason: 'surface-tab' },
  });
}

/** A user draft belongs to this mounted presentation node; this callback creates no owner state or authority. */
export function WorkspacePreviewIntentProvider({ surfaceId, children }: { surfaceId: string; children: ReactNode }) {
  const promote = useCallback(() => promoteWorkspacePreview(surfaceId), [surfaceId]);
  return <PreviewIntent.Provider value={promote}>{children}</PreviewIntent.Provider>;
}

/** Review surfaces outside an F307 host keep their original controller behavior. */
export function useWorkspacePreviewIntent() {
  return useContext(PreviewIntent);
}
