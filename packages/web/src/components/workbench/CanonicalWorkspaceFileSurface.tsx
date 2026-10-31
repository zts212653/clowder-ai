'use client';
import type { ReactNode } from 'react';
import { ArtifactFileSourceResolver } from './ArtifactFileSourceResolver';
import { useResolveContentSurface } from './ContentSurfaceResolution';
import { resolveFileTarget } from './real-surface-adapters';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

/** Every F063 alias resolves before mounting an editor, so all entrances share one stable owner. */
export function CanonicalWorkspaceFileSurface({
  surface,
  onBack,
  children,
}: {
  readonly surface: WorkspaceSurfaceDescriptor;
  readonly onBack: () => void;
  readonly children: ReactNode;
}) {
  const resolveSurface = useResolveContentSurface(surface.id);
  const target = resolveFileTarget(surface);
  if (!target || /^f063_root_v1_[a-f0-9]{64}$/.test(target.worktreeId)) return children;
  return (
    <ArtifactFileSourceResolver
      key={JSON.stringify(target)}
      {...target}
      rootSelection={surface.rootSelection}
      title={surface.title}
      perFileIdentity={surface.objectRef.id !== target.worktreeId}
      onBack={onBack}
      onResolved={(resolved) => resolveSurface(resolved)}
    />
  );
}
