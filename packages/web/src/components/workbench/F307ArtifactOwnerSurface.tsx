'use client';
import { useState } from 'react';

import { ArtifactDetailView } from '@/components/artifacts/ArtifactDetailView';
import { useThreadArtifacts } from '@/hooks/useThreadArtifacts';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { ArtifactFileSourceResolver } from './ArtifactFileSourceResolver';
import { ArtifactPublicationSurface } from './ArtifactPublicationSurface';
import { useF307ExperienceWorkbenchStore } from './experience-workbench-store';
import { F307OwnerUnavailable as OwnerUnavailable } from './F307OwnerUnavailable';
import { LegacyArtifactFileResolver } from './LegacyArtifactFileResolver';
import { artifactObjectId, legacyArtifactObjectId, resolveArtifactTarget } from './real-surface-adapters';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

export function F307ArtifactOwnerSurface({
  surface,
  onRequestDetach,
}: {
  surface: WorkspaceSurfaceDescriptor;
  onRequestDetach: () => void;
  onOpenSurface: (surface: WorkspaceSurfaceDescriptor) => void;
}) {
  const target = resolveArtifactTarget(surface);
  const { artifacts, loading, error } = useThreadArtifacts(target?.threadId);
  const [selected, setSelected] = useState<string | null>(null);
  if (!target) return <OwnerUnavailable message="Artifact descriptor 没有合法的 F232 owner 引用。" />;
  if (loading) return <div className="p-5 text-xs text-cafe-muted">正在从原 Thread 恢复产物…</div>;
  if (error) return <OwnerUnavailable message="F232 产物 owner 暂时不可用；Workbench 没有猜测或复制内容。" />;
  const matches = artifacts.filter(
    (candidate) =>
      artifactObjectId(candidate) === target.artifactId || legacyArtifactObjectId(candidate) === target.artifactId,
  );
  const artifact =
    matches.length === 1 ? matches[0] : matches.find((candidate) => artifactObjectId(candidate) === selected);
  if (!artifact && matches.length > 1)
    return (
      <section className="space-y-3 p-4">
        <p>旧入口对应多件作品，请选择要继续的那一项。</p>
        {matches.map((candidate, index) => (
          <button
            key={artifactObjectId(candidate)}
            type="button"
            onClick={() => setSelected(artifactObjectId(candidate))}
            className="block rounded border border-cafe px-3 py-2"
          >
            {candidate.name} · 第 {index + 1} 项
          </button>
        ))}
      </section>
    );
  if (!artifact) return <OwnerUnavailable message="原 owner 已找不到这个产物；其余 Workbench surface 保持可用。" />;
  if (
    (artifact.type === 'file' || artifact.type === 'code') &&
    !artifact.url &&
    artifact.ref &&
    !artifact.ref.startsWith('/')
  )
    return (
      <LegacyArtifactFileResolver
        key={`${target.threadId}:${target.artifactId}`}
        source={{
          threadId: target.threadId,
          artifactId: artifactObjectId(artifact),
          ...(artifact.fileLedgerRef ? { fileLedgerRef: artifact.fileLedgerRef } : {}),
          path: artifact.ref,
          title: artifact.name,
        }}
        onBack={onRequestDetach}
        onResolved={(resolved) =>
          useF307ExperienceWorkbenchStore
            .getState()
            .dispatch({ type: 'resolve-content-surface', sourceSurfaceId: surface.id, surface: resolved })
        }
      />
    );
  if ((artifact.type === 'file' || artifact.type === 'code') && !artifact.url && artifact.ref?.startsWith('/'))
    return (
      <ArtifactFileSourceResolver
        key={`${target.threadId}:${target.artifactId}`}
        path={artifact.ref}
        title={artifact.name}
        onBack={onRequestDetach}
        onResolved={(resolved) =>
          useF307ExperienceWorkbenchStore.getState().dispatch({
            type: 'resolve-content-surface',
            sourceSurfaceId: surface.id,
            surface: resolved,
          })
        }
      />
    );
  if (artifact.url && /^\/uploads\/[^/]+\.(png|mp4)$/i.test(artifact.url))
    return (
      <ArtifactPublicationSurface
        key={`${target.threadId}:${target.artifactId}`}
        artifact={artifact}
        surface={surface}
        onResolved={(resolved) =>
          useF307ExperienceWorkbenchStore
            .getState()
            .dispatch({ type: 'resolve-content-surface', sourceSurfaceId: surface.id, surface: resolved })
        }
        threadId={target.threadId}
        onBack={onRequestDetach}
      />
    );
  return (
    <ArtifactDetailView
      artifact={artifact}
      worktreeId={null}
      onBack={onRequestDetach}
      onJump={(messageId) => scrollToMessage(messageId)}
    />
  );
}
