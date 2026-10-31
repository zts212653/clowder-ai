'use client';
import { type ReactNode, useRef, useState } from 'react';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { resolveArtifactReviewTarget } from './artifact-review-surface';
import { useResolveContentSurface } from './ContentSurfaceResolution';
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
  children: ReactNode | ((leadingAction?: ReactNode) => ReactNode);
}) {
  const resolveSurface = useResolveContentSurface(surface.id);
  const isV2 = useShellPresentation() === 'v2';
  const [choosing, setChoosing] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const visible = useWorkspaceSurfaceVisibility();
  const source = surface.messagePublicationSource;
  const render = (leadingAction?: ReactNode) => (typeof children === 'function' ? children(leadingAction) : children);
  if (!source) return render();
  const inHeader =
    isV2 &&
    typeof children === 'function' &&
    (surface.ownerStateRef.owner === 'f138-publication' || resolveArtifactReviewTarget(surface) !== null);
  const switchAction = (
    <button
      ref={trigger}
      type="button"
      className="shrink-0 rounded-md px-2 py-1 text-xs text-cafe-muted hover:text-cafe"
      onClick={() => setChoosing(true)}
    >
      切换原作品
    </button>
  );
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
              resolveSurface(resolved);
              setChoosing(false);
            }}
          />
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col" style={choosing ? { display: 'none' } : undefined}>
        {!inHeader ? <div className="flex shrink-0 justify-end px-3 pt-2">{switchAction}</div> : null}
        <WorkspaceSurfaceVisibilityProvider visible={visible && !choosing}>
          {render(inHeader ? switchAction : undefined)}
        </WorkspaceSurfaceVisibilityProvider>
      </div>
    </div>
  );
}
