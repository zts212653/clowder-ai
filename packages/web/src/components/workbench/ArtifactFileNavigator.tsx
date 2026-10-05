'use client';
import { type ReactNode, useRef, useState } from 'react';
import { useF307ExperienceWorkbenchStore } from './experience-workbench-store';
import { LegacyArtifactFileResolver } from './LegacyArtifactFileResolver';
import { useWorkspaceSurfaceVisibility, WorkspaceSurfaceVisibilityProvider } from './WorkspaceSurfaceVisibility';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

/** Keep the original file editor mounted until an explicit replacement actually resolves. */
export function ArtifactFileNavigator({
  surface,
  children,
}: {
  readonly surface: WorkspaceSurfaceDescriptor;
  readonly children: ReactNode;
}) {
  const [choosing, setChoosing] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const visible = useWorkspaceSurfaceVisibility();
  const source = surface.artifactFileSource;
  if (!source) return children;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!choosing && (
        <div className="flex flex-wrap items-center gap-2 border-b border-cafe-subtle px-3 py-2 text-xs">
          <span>当前选定位置：{source.selectedLocation?.label ?? source.title}</span>
          <button ref={trigger} type="button" onClick={() => setChoosing(true)}>
            选择其他位置
          </button>
          {source.selectedLocation && (
            <details>
              <summary>位置详情</summary>
              <p className="break-all">{source.selectedLocation.absolutePath}</p>
            </details>
          )}
        </div>
      )}
      <div hidden={choosing} className={choosing ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
        <WorkspaceSurfaceVisibilityProvider visible={visible && !choosing}>
          {children}
        </WorkspaceSurfaceVisibilityProvider>
      </div>
      {choosing && (
        <LegacyArtifactFileResolver
          key={JSON.stringify([source.threadId, source.artifactId])}
          source={source}
          forceChoice
          onBack={() => {
            setChoosing(false);
            requestAnimationFrame(() => trigger.current?.focus());
          }}
          onResolved={(next) => {
            useF307ExperienceWorkbenchStore
              .getState()
              .dispatch({ type: 'resolve-content-surface', sourceSurfaceId: surface.id, surface: next });
            setChoosing(false);
          }}
        />
      )}
    </div>
  );
}
