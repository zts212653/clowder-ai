'use client';

import { createContext, type ReactNode, useContext } from 'react';

const WorkspaceSurfaceVisibilityContext = createContext(true);

export function WorkspaceSurfaceVisibilityProvider({ visible, children }: { visible: boolean; children: ReactNode }) {
  return (
    <WorkspaceSurfaceVisibilityContext.Provider value={visible}>{children}</WorkspaceSurfaceVisibilityContext.Provider>
  );
}

/** True outside F307 so standalone owners keep their existing lifecycle. */
export function useWorkspaceSurfaceVisibility(): boolean {
  return useContext(WorkspaceSurfaceVisibilityContext);
}
