'use client';
import { type ReactNode, useRef, useState } from 'react';
import { useF307ExperienceWorkbenchStore } from './experience-workbench-store';
import { MessagePublicationLandingResolver } from './MessagePublicationLandingResolver';
import { createMessagePublicationSurface } from './message-publication-surface';
import { useWorkspaceSurfaceVisibility, WorkspaceSurfaceVisibilityProvider } from './WorkspaceSurfaceVisibility';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

/** A navigation-only chooser keeps the original owner mounted until an explicit resolved choice. */
export function ContentPublicationNavigator({
  surface,
  children,
}: {
  surface: WorkspaceSurfaceDescriptor;
  children: ReactNode;
}) {
  const [choosing, setChoosing] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const visible = useWorkspaceSurfaceVisibility();
  const source = surface.messagePublicationSource;
  if (!source) return children;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {choosing ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <MessagePublicationLandingResolver
            source={source}
            surface={createMessagePublicationSurface(source, surface.title)}
            forceChoice
            onBack={() => {
              setChoosing(false);
              requestAnimationFrame(() => trigger.current?.focus());
            }}
            onResolved={(resolved) => {
              useF307ExperienceWorkbenchStore
                .getState()
                .dispatch({ type: 'resolve-content-surface', sourceSurfaceId: surface.id, surface: resolved });
              setChoosing(false);
            }}
          />
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col" style={choosing ? { display: 'none' } : undefined}>
        <div className="flex shrink-0 justify-end px-3 pt-2">
          <button ref={trigger} type="button" className="text-xs text-cafe-muted" onClick={() => setChoosing(true)}>
            切换原作品
          </button>
        </div>
        <WorkspaceSurfaceVisibilityProvider visible={visible && !choosing}>
          {children}
        </WorkspaceSurfaceVisibilityProvider>
      </div>
    </div>
  );
}
