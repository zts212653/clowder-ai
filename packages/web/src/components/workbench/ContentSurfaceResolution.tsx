'use client';
import { createContext, type ReactNode, useContext } from 'react';
import { useF307ExperienceWorkbenchStore } from './experience-workbench-store';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

type Resolve = (surface: WorkspaceSurfaceDescriptor, sourceSurfaceId: string) => void;
const Context = createContext<Resolve | null>(null);
/** Resolving an owner replaces its descriptor in the same host; it never opens another host implicitly. */
export function ContentSurfaceResolutionProvider({ resolve, children }: { resolve: Resolve; children: ReactNode }) {
  return <Context.Provider value={resolve}>{children}</Context.Provider>;
}
export function useResolveContentSurface(sourceSurfaceId: string): (surface: WorkspaceSurfaceDescriptor) => void {
  const resolve = useContext(Context);
  return (surface) =>
    resolve
      ? resolve(surface, sourceSurfaceId)
      : useF307ExperienceWorkbenchStore
          .getState()
          .dispatch({ type: 'resolve-content-surface', sourceSurfaceId, surface });
}
